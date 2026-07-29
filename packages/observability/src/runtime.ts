import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import { initializeRegisteredTelemetry } from "./telemetry.js";

const defaultMetricExportIntervalMs = 60_000;
const defaultExportTimeoutMs = 5_000;
const serviceNamePattern = /^[a-z0-9][a-z0-9._-]{2,63}$/u;
let registered = false;

export interface ObservabilityRuntimeOptions {
  readonly endpoint?: string;
  readonly environment: string;
  readonly production: boolean;
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly traceSampleRatio?: number;
  readonly metricExportIntervalMs?: number;
  readonly exportTimeoutMs?: number;
  /**
   * Application-owned selection. It is never read from the ambient OpenTelemetry environment.
   * Worker delta collection lets an unobserved leased gauge disappear after ownership loss.
   */
  readonly metricTemporality?: "cumulative" | "delta";
}

export interface ObservabilityRuntime {
  readonly enabled: boolean;
  readonly serviceName: string;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface OtlpSignalEndpoints {
  readonly traces: string;
  readonly metrics: string;
}

/**
 * Starts an explicit OTLP/HTTP protobuf pipeline. No automatic instrumentation or resource
 * detection is enabled, so only allowlisted ReconAI instruments and resource attributes leave the
 * process.
 */
export function startObservability(options: ObservabilityRuntimeOptions): ObservabilityRuntime {
  validateServiceIdentity(options);
  if (!options.endpoint) {
    if (options.production) {
      throw new Error("production observability requires OTEL_EXPORTER_OTLP_ENDPOINT");
    }
    return disabledRuntime(options.serviceName);
  }
  if (registered) throw new Error("observability has already been started in this process");

  const endpoints = resolveOtlpSignalEndpoints(options.endpoint, options.production);
  const exportTimeoutMs = boundedInteger(
    options.exportTimeoutMs ?? defaultExportTimeoutMs,
    100,
    30_000,
    "observability export timeout",
  );
  const metricExportIntervalMs = boundedInteger(
    options.metricExportIntervalMs ?? defaultMetricExportIntervalMs,
    exportTimeoutMs,
    300_000,
    "metric export interval",
  );
  const traceSampleRatio = options.traceSampleRatio ?? 0.1;
  if (!Number.isFinite(traceSampleRatio) || traceSampleRatio < 0 || traceSampleRatio > 1) {
    throw new Error("trace sample ratio must be between 0 and 1");
  }

  const resource = resourceFromAttributes({
    "service.name": options.serviceName,
    "deployment.environment.name": options.environment,
    ...(options.serviceVersion ? { "service.version": options.serviceVersion } : {}),
  });
  const metricExporter = new OTLPMetricExporter({
    url: endpoints.metrics,
    timeoutMillis: exportTimeoutMs,
    concurrencyLimit: 1,
    keepAlive: true,
    userAgent: "reconai-telemetry",
    temporalityPreference:
      options.metricTemporality === "delta"
        ? AggregationTemporality.DELTA
        : AggregationTemporality.CUMULATIVE,
  });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: metricExportIntervalMs,
    exportTimeoutMillis: exportTimeoutMs,
    cardinalityLimits: { default: 256 },
    maxExportBatchSize: 256,
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [metricReader],
  });
  const traceExporter = new OTLPTraceExporter({
    url: endpoints.traces,
    timeoutMillis: exportTimeoutMs,
    concurrencyLimit: 1,
    keepAlive: true,
    userAgent: "reconai-telemetry",
  });
  const ratioSampler = new TraceIdRatioBasedSampler(traceSampleRatio);
  const tracerProvider = new NodeTracerProvider({
    resource,
    sampler: new ParentBasedSampler({
      root: ratioSampler,
      remoteParentSampled: ratioSampler,
      remoteParentNotSampled: ratioSampler,
    }),
    forceFlushTimeoutMillis: exportTimeoutMs,
    spanLimits: {
      attributeCountLimit: 16,
      attributeValueLengthLimit: 256,
      eventCountLimit: 0,
      linkCountLimit: 4,
    },
    spanProcessors: [
      new BatchSpanProcessor(traceExporter, {
        maxQueueSize: 2_048,
        maxExportBatchSize: 256,
        scheduledDelayMillis: Math.min(5_000, metricExportIntervalMs),
        exportTimeoutMillis: exportTimeoutMs,
      }),
    ],
  });

  metrics.setGlobalMeterProvider(meterProvider);
  tracerProvider.register();
  initializeRegisteredTelemetry();
  registered = true;
  let stopped = false;

  return {
    enabled: true,
    serviceName: options.serviceName,
    forceFlush: async () => {
      if (stopped) return;
      await Promise.all([tracerProvider.forceFlush(), meterProvider.forceFlush()]);
    },
    shutdown: async () => {
      if (stopped) return;
      stopped = true;
      await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
    },
  };
}

export function resolveOtlpSignalEndpoints(
  endpoint: string,
  production: boolean,
): OtlpSignalEndpoints {
  const base = new URL(endpoint);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("OTLP endpoint must use HTTP or HTTPS");
  }
  if (production && base.protocol !== "https:") {
    throw new Error("production OTLP endpoint must use HTTPS");
  }
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error(
      "OTLP endpoint must be an origin without credentials, path, query, or fragment",
    );
  }
  return {
    traces: new URL("/v1/traces", base).toString(),
    metrics: new URL("/v1/metrics", base).toString(),
  };
}

function validateServiceIdentity(options: ObservabilityRuntimeOptions): void {
  if (!serviceNamePattern.test(options.serviceName)) {
    throw new Error("observability service name is invalid");
  }
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/u.test(options.environment)) {
    throw new Error("observability environment is invalid");
  }
  if (
    options.serviceVersion !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(options.serviceVersion)
  ) {
    throw new Error("observability service version is invalid");
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${String(minimum)} and ${String(maximum)}`);
  }
  return value;
}

function disabledRuntime(serviceName: string): ObservabilityRuntime {
  return {
    enabled: false,
    serviceName,
    forceFlush: async () => undefined,
    shutdown: async () => undefined,
  };
}

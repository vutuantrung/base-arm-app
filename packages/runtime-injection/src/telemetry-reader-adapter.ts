import type { TelemetryReader, TelemetrySnapshot } from '../../contracts/src/index.js';
import { ArmTelemetryReader } from './arm-telemetry-reader.js';

/**
 * Maps best-effort Phase 8 raw telemetry into the R1 read-only metrics DTO.
 * This does not assert PID liveness, ARM component readiness or freshness.
 */
export class ArmTelemetryReaderAdapter implements TelemetryReader {
  constructor(private readonly source: ArmTelemetryReader) {}

  async read(instanceId: string): Promise<TelemetrySnapshot | undefined> {
    const sample = await this.source.read(instanceId);
    if (!sample) return undefined;
    return {
      applicationId: sample.applicationId,
      instanceId: sample.instanceId,
      observedAt: sample.timestamp,
      metrics: [
        { name: 'process.memory.rss_bytes', value: sample.rssBytes },
        { name: 'process.memory.heap_used_bytes', value: sample.heapUsedBytes },
        { name: 'process.event_loop.utilization', value: sample.eventLoopUtilization },
        { name: 'process.event_loop.delay_mean_ms', value: sample.eventLoopDelayMeanMs },
        { name: 'process.event_loop.delay_max_ms', value: sample.eventLoopDelayMaxMs },
        { name: 'http.server.requests_started', value: sample.requestsStarted },
        { name: 'http.server.responses_finished', value: sample.responsesFinished },
        { name: 'http.server.responses_5xx', value: sample.responses5xx },
        { name: 'process.uncaught_exceptions', value: sample.uncaughtExceptions },
      ],
    };
  }
}

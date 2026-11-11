import type {
  ProcessController, ProcessInstance, ProcessLaunchRequest,
} from '../../contracts/src/index.js';
import { ProcessManager, type ProcessSpec, type ProcessView } from './process-manager.js';

const ID = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * Adapts the existing durable ProcessManager to the R1 ProcessController port.
 * Adapter owns DTO mapping; ProcessManager continues to own PID/port registry.
 *
 * Precondition: initialize ProcessManager once before invoking this adapter.
 * Endpoint is ASSIGNED (not BOUND or READY), until bind confirmation exists.
 */
export class ProcessControllerAdapter implements ProcessController {
  constructor(private readonly processes: ProcessManager) {}

  async start(request: ProcessLaunchRequest): Promise<ProcessInstance> {
    this.validateIdentity(request);
    await this.processes.registerSpec(this.toProcessSpec(request));
    const state = await this.processes.start(request.instanceId);
    return this.toProcessInstance(
      request.instanceId,
      request.applicationId,
      await this.processes.inspect(request.instanceId),
      state.startedAt,
    );
  }

  async stop(instanceId: string): Promise<void> {
    await this.processes.stop(instanceId);
  }

  async restart(instanceId: string): Promise<ProcessInstance> {
    const spec = this.processes.getSpec(instanceId);
    const state = await this.processes.restart(instanceId);
    return this.toProcessInstance(
      instanceId,
      spec.env?.ARM_APPLICATION_ID ?? spec.id,
      await this.processes.inspect(instanceId),
      state.startedAt,
    );
  }

  async inspect(instanceId: string): Promise<ProcessInstance> {
    const spec = this.processes.getSpec(instanceId);
    return this.toProcessInstance(
      instanceId,
      spec.env?.ARM_APPLICATION_ID ?? spec.id,
      await this.processes.inspect(instanceId),
    );
  }

  private validateIdentity(request: ProcessLaunchRequest): void {
    if (!ID.test(request.applicationId) || !ID.test(request.instanceId)) {
      throw new Error('Invalid process controller identity');
    }
  }

  private toProcessSpec(request: ProcessLaunchRequest): ProcessSpec {
    return {
      id: request.instanceId,
      entry: request.entry,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.arguments ? { args: [...request.arguments] } : {}),
      ...(request.applicationEnvironment ? {
        applicationEnv: { ...request.applicationEnvironment },
      } : {}),
      env: {
        ...request.runtimeEnvironment,
        // Canonical identity must not be replaced by an arbitrary caller env.
        ARM_APPLICATION_ID: request.applicationId,
        ARM_INSTANCE_ID: request.instanceId,
      },
    };
  }

  private toProcessInstance(
    instanceId: string,
    applicationId: string,
    view: ProcessView,
    startedAt?: string,
  ): ProcessInstance {
    return {
      instanceId,
      applicationId,
      status: view.status,
      adopted: view.adopted,
      ...(view.pid !== undefined ? { pid: view.pid } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(view.port !== undefined ? {
        endpoint: {
          host: '127.0.0.1',
          port: view.port,
          state: 'ASSIGNED' as const,
        },
      } : {}),
    };
  }
}

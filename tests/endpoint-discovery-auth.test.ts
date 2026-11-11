import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationManagementApi } from '../packages/adapter-process/src/application-management-api.js';
import type { ApplicationRuntimeMonitor } from '../packages/adapter-process/src/application-runtime-monitor.js';
import type { ApplicationEndpointDiscovery } from '../packages/adapter-process/src/application-endpoint-discovery.js';

test('Discovery token is restricted to read-only endpoint discovery', async () => {
  const endpoint = {
    applicationId: 'payment-service', instanceId: 'payment-service-managed',
    url: 'http://127.0.0.1:41000', host: '127.0.0.1' as const,
    port: 41000, mode: 'singleton' as const, reachable: true as const,
  };
  const endpoints = {
    list: async () => [endpoint],
    find: async (id: string) => id === 'payment-service' ? endpoint : undefined,
  } as ApplicationEndpointDiscovery;
  const api = new ApplicationManagementApi({} as ApplicationRuntimeMonitor, {
    bearerToken: 'management-secret-with-sufficient-length',
    discoveryToken: 'discovery-secret-with-sufficient-length',
    endpointDiscovery: endpoints, port: 0,
  });
  try {
    await api.start();
    const address = api.http.address();
    if (!address || typeof address === 'string') throw new Error('Management API not bound');
    const base = `http://127.0.0.1:${address.port}`;
    const token = { authorization: 'Bearer discovery-secret-with-sufficient-length' };
    const response = await fetch(base + '/runtime/endpoints/payment-service',
      { headers: token });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { url: string }).url, endpoint.url);
    assert.equal((await fetch(base + '/applications', { headers: token })).status, 401);
    assert.equal((await fetch(base + '/runtime/endpoints/payment-service')).status, 401);
    assert.equal((await fetch(base + '/runtime/endpoints/not-found',
      { headers: token })).status, 404);
  } finally {
    await api.stop();
  }
});

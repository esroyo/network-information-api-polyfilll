import { assertEquals, assertExists, assertInstanceOf } from '@std/assert';
import { assertSpyCalls, spy, stub } from '@std/testing/mock';
import { FakeTime } from '@std/testing/time';

import { NetworkInformationApi as RealNetworkInformationApi } from './network-information.ts';

class NetworkInformationApi extends RealNetworkInformationApi {
    /** Avoid init on tests */
    protected override async _init(): Promise<void> {}
}

// Test Suite
Deno.test('NetworkInformationApi - Constructor', () => {
    const api = new NetworkInformationApi();

    assertInstanceOf(api, EventTarget);
    assertEquals(api.saveData, false);
    assertEquals(api.type, 'unknown');
    assertEquals(api.downlink, undefined);
    assertEquals(api.uplink, undefined);
    assertEquals(api.rtt, undefined);
    assertEquals(api.effectiveType, undefined);
});

Deno.test('NetworkInformationApi - Constructor with options', () => {
    const options = {
        cfOrigin: 'https://custom.test.com',
        measurementCount: 5,
        baseMeasurementSize: 50000,
        periodicMeasurement: true,
    };

    const api = new NetworkInformationApi(options);

    // Test that options are applied (accessing protected properties for testing)
    assertEquals((api as any)._cfOrigin, 'https://custom.test.com');
    assertEquals((api as any)._measurementCount, 5);
    assertEquals((api as any)._baseMeasurementSize, 50000);
    assertEquals((api as any)._periodicMeasurement, true);
});

Deno.test('NetworkInformationApi - Classification logic', () => {
    const api = new NetworkInformationApi();

    // Test classification boundaries
    assertEquals((api as any)._classifyConnection(0.1, 100), 'slow-2g');
    assertEquals((api as any)._classifyConnection(0.5, 200), '2g');
    assertEquals((api as any)._classifyConnection(2.0, 80), '3g');
    assertEquals((api as any)._classifyConnection(8.0, 30), '4g');

    // Test edge cases
    assertEquals((api as any)._classifyConnection(0, 100), 'slow-2g');
    assertEquals((api as any)._classifyConnection(Infinity, 100), 'slow-2g');
    assertEquals((api as any)._classifyConnection(5.0, 3000), 'slow-2g');
});

Deno.test('NetworkInformationApi - Median calculation', () => {
    const api = new NetworkInformationApi();

    // Test odd length array
    assertEquals((api as any)._median([1, 3, 5]), 3);

    // Test even length array
    assertEquals((api as any)._median([1, 2, 4, 5]), 3);

    // Test single element
    assertEquals((api as any)._median([42]), 42);

    // Test two elements
    assertEquals((api as any)._median([10, 20]), 15);
});

Deno.test('NetworkInformationApi - Pseudo random hash', () => {
    const api = new NetworkInformationApi();

    const hash1 = (api as any)._pseudoRandomHash(5);
    const hash2 = (api as any)._pseudoRandomHash(5);

    assertEquals(hash1.length, 5);
    assertEquals(hash2.length, 5);

    // Should be different (extremely unlikely to be same)
    assertEquals(hash1 === hash2, false);

    // Test custom length
    const hash3 = (api as any)._pseudoRandomHash(20);
    assertEquals(hash3.length, 20);
});

Deno.test('NetworkInformationApi - Event dispatching', async () => {
    const api = new NetworkInformationApi();
    let eventFired = false;
    let eventDetail: any = null;

    api.addEventListener('change', (event) => {
        eventFired = true;
        eventDetail = (event as CustomEvent).detail;
    });

    const testData = {
        downlink: 5.0,
        uplink: 2.5,
        rtt: 50,
        effectiveType: '4g',
        preliminary: true,
    };

    (api as any)._dispatchNetworkEvent('change', testData);

    // Allow event to process
    await new Promise((resolve) => setTimeout(resolve, 0));

    assertEquals(eventFired, true);
    assertEquals(eventDetail.downlink, 5.0);
    assertEquals(eventDetail.effectiveType, '4g');
    assertEquals(eventDetail.preliminary, true);
});

Deno.test('NetworkInformationApi - getConnectionInfo', () => {
    const api = new NetworkInformationApi();

    // Set some test values
    (api as any)._downlink = 3.5;
    (api as any)._uplink = 1.75;
    (api as any)._rtt = 75;
    (api as any)._effectiveType = '3g';

    const info = api.getConnectionInfo();

    assertEquals(info.downlink, 3.5);
    assertEquals(info.uplink, 1.75);
    assertEquals(info.rtt, 75);
    assertEquals(info.effectiveType, '3g');
    assertEquals(info.saveData, false);
    assertEquals(info.type, 'unknown');
});

Deno.test('NetworkInformationApi - Measurement state management', async () => {
    const api = new NetworkInformationApi();

    // Mock fetch to avoid real network calls
    const originalFetch = globalThis.fetch;
    globalThis.fetch = spy(() =>
        Promise.resolve(
            new Response('test', {
                headers: { 'server-timing': 'dur=10' },
            }),
        )
    );

    try {
        assertEquals((api as any)._measuring, false);

        // Start measurement
        const measurePromise = api.measure();
        assertEquals((api as any)._measuring, true);

        await measurePromise;
        assertEquals((api as any)._measuring, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

Deno.test('NetworkInformationApi - Concurrent measurement prevention', async () => {
    const api = new NetworkInformationApi();

    // Mock fetch to simulate slow network
    const originalFetch = globalThis.fetch;
    globalThis.fetch = spy(() =>
        new Promise((resolve) =>
            setTimeout(() => resolve(new Response('test')), 100)
        )
    );

    try {
        // Start first measurement
        const promise1 = api.measure();
        assertEquals((api as any)._measuring, true);

        // Try to start second measurement (should be ignored)
        const promise2 = api.measure();

        await Promise.all([promise1, promise2]);

        // Both should resolve, but second should return immediately
        assertEquals((api as any)._measuring, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

Deno.test('NetworkInformationApi - Periodic measurements', async () => {
    const time = new FakeTime();

    const api = new NetworkInformationApi({
        periodicMeasurement: true,
        measurementInterval: 5000,
    });

    // Mock the measurement method
    const measureSpy = stub(api, '_performMeasurement' as any);

    // Start periodic measurements
    (api as any)._startPeriodicMeasurements();

    // Fast forward time
    time.tick(15000); // 15 seconds

    // Should have called measurement at least once during periodic checks
    assertSpyCalls(measureSpy, 1); // Initial call doesn't happen due to mocked _init

    measureSpy.restore();
    time.restore();
});

Deno.test('NetworkInformationApi - Error handling in measurement', async () => {
    const api = new NetworkInformationApi();

    // Mock fetch to throw error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = spy(() => Promise.reject(new Error('Network error')));

    try {
        // Should not throw, should handle error silently
        await api.measure();

        // Measurement should be reset to false even after error
        assertEquals((api as any)._measuring, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

Deno.test('NetworkInformationApi - Update from measurements with empty array', () => {
    const api = new NetworkInformationApi();

    // Should handle empty measurements array gracefully
    (api as any)._updateFromMeasurements([]);

    // Values should remain undefined
    assertEquals(api.downlink, undefined);
    assertEquals(api.uplink, undefined);
    assertEquals(api.rtt, undefined);
    assertEquals(api.effectiveType, undefined);
});

Deno.test('NetworkInformationApi - Update from first measurement', async () => {
    const api = new NetworkInformationApi();
    let changeEventFired = false;

    api.addEventListener('change', () => {
        changeEventFired = true;
    });

    const measurement = {
        rtt: 100,
        downlink: 2.0,
        measurementSize: 100000,
        duration: 500,
        realDuration: 510,
        timestamp: Date.now(),
    };

    (api as any)._updateFromFirstMeasurement(measurement);

    // Allow event to process
    await new Promise((resolve) => setTimeout(resolve, 0));

    assertEquals(api.rtt, 100);
    assertEquals(api.downlink, 2.0);
    assertEquals(api.uplink, 1.0); // 50% of downlink
    assertEquals(api.effectiveType, '3g');
    assertEquals(changeEventFired, true);
});

// Integration test with real network (optional, requires --allow-net)
Deno.test({
    name: 'NetworkInformationApi - Real network integration',
    ignore: false, // Set to false to run real network tests
    permissions: { net: true },
    fn: async () => {
        const api = new RealNetworkInformationApi({
            measurementCount: 1,
            baseMeasurementSize: 1000, // Small size for faster test
        });

        // Wait for initial measurement
        await new Promise((resolve) => setTimeout(resolve, 5000));

        assertExists(api.downlink);
        assertExists(api.uplink);
        assertExists(api.rtt);
        assertExists(api.effectiveType);

        const info = api.getConnectionInfo();
        assertExists(info.downlink);
        assertExists(info.uplink);
        assertExists(info.rtt);
        assertExists(info.effectiveType);
    },
});

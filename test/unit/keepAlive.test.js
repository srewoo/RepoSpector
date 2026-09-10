/**
 * A local model turns a review that used to fail in two seconds into one that
 * runs for minutes, and MV3 kills an idle service worker after ~30s. The popup
 * then reports "A listener indicated an asynchronous response by returning
 * true, but the message channel closed before a response was received" — the
 * worker died mid-handler.
 *
 * Only an extension API call resets that idle timer; `fetch` and `setInterval`
 * do not. These tests pin the ping actually firing while work is in flight,
 * and stopping when it is not.
 */
const {
    createKeepAlive,
    KEEPALIVE_INTERVAL_MS,
} = require('../../src/background/keepAlive.js');

function fakeTimers() {
    let next = 1;
    const intervals = new Map();
    return {
        setInterval: (fn, ms) => { const id = next++; intervals.set(id, { fn, ms }); return id; },
        clearInterval: (id) => { intervals.delete(id); },
        count: () => intervals.size,
        msOf: (id) => intervals.get(id)?.ms,
        tick: () => intervals.forEach(({ fn }) => fn()),
    };
}

describe('createKeepAlive', () => {
    test('pings on an interval shorter than the 30s idle kill while work is in flight', () => {
        const timers = fakeTimers();
        const ping = jest.fn();
        const ka = createKeepAlive({ ping, timers });

        expect(timers.count()).toBe(0); // idle: no timer, worker free to sleep

        const end = ka.begin();
        expect(timers.count()).toBe(1);
        expect(timers.msOf(1)).toBeLessThan(30000);
        expect(KEEPALIVE_INTERVAL_MS).toBeLessThan(30000);

        timers.tick();
        timers.tick();
        expect(ping).toHaveBeenCalledTimes(2);

        end();
        expect(timers.count()).toBe(0);
    });

    test('concurrent work shares one timer and the last one out stops it', () => {
        const timers = fakeTimers();
        const ka = createKeepAlive({ ping: jest.fn(), timers });

        const endA = ka.begin();
        const endB = ka.begin();
        expect(timers.count()).toBe(1);

        endA();
        expect(timers.count()).toBe(1); // B is still working

        endB();
        expect(timers.count()).toBe(0);
    });

    test('end is idempotent, so a double-release cannot strand the timer', () => {
        const timers = fakeTimers();
        const ka = createKeepAlive({ ping: jest.fn(), timers });

        const endA = ka.begin();
        const endB = ka.begin();
        endA();
        endA();
        expect(timers.count()).toBe(1);

        endB();
        expect(timers.count()).toBe(0);
    });

    test('a throwing ping does not stop the keepalive', () => {
        const timers = fakeTimers();
        const ping = jest.fn(() => { throw new Error('worker restarting'); });
        const ka = createKeepAlive({ ping, timers });

        ka.begin();
        expect(() => timers.tick()).not.toThrow();
        expect(timers.count()).toBe(1);
    });
});

package com.zenzig.plugins.socketio;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Covers ForegroundQuota's pure clear-after-24h predicate without requiring an
 * Android Context (a plain JVM test that runs as part of the app's Gradle build).
 */
public class ForegroundQuotaTest {

    private static final long ONE_HOUR_MS = 60L * 60L * 1000L;

    @Test
    public void noMarkIsNotExhausted() {
        assertFalse(ForegroundQuota.isExhausted(-1L, 1_000_000L));
    }

    @Test
    public void freshMarkIsExhausted() {
        long now = 1_000_000_000L;
        assertTrue(ForegroundQuota.isExhausted(now, now));
        assertTrue(ForegroundQuota.isExhausted(now - ONE_HOUR_MS, now));
    }

    @Test
    public void markJustUnder24hIsStillExhausted() {
        long now = 1_000_000_000L;
        long exhaustedAt = now - (ForegroundQuota.MAX_AGE_MS - 1000L);
        assertTrue(ForegroundQuota.isExhausted(exhaustedAt, now));
    }

    @Test
    public void markAtOrPast24hIsNoLongerExhausted() {
        long now = 1_000_000_000L;
        long exhaustedAtExactly24h = now - ForegroundQuota.MAX_AGE_MS;
        assertFalse(ForegroundQuota.isExhausted(exhaustedAtExactly24h, now));

        long exhaustedAtOver24h = now - ForegroundQuota.MAX_AGE_MS - ONE_HOUR_MS;
        assertFalse(ForegroundQuota.isExhausted(exhaustedAtOver24h, now));
    }

    @Test
    public void markInTheFutureIsTreatedAsExhausted() {
        // Defensive: a clock skew that puts the mark slightly ahead of "now" should
        // not be treated as an instantly-stale (negative-age) mark.
        long now = 1_000_000_000L;
        assertTrue(ForegroundQuota.isExhausted(now + 1000L, now));
    }
}

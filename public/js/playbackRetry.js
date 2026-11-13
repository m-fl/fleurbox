/**
 * Playback recovery shared by both players (VideoPlayer = Live TV,
 * WatchPage = movies/series).
 *
 * After a playback failure, schedule() runs `run` again after 1s, 2s, 4s, 8s,
 * 15s, 30s; after that the player shows "Playback stopped" with a Retry
 * button. Before each attempt it:
 *  - waits while the browser is offline or the page is hidden, and carries
 *    on (without using up an attempt) on 'online' / 'visibilitychange';
 *  - asks the server whether the login still works: a 401 ends retrying and
 *    Session shows "log in again" (retrying a dead login can't work); an
 *    unreachable server uses up an attempt and tries again later.
 * 15s of steady playback (playing()) gives a later failure fresh attempts,
 * and so does a different `key` (another title or channel).
 */
class PlaybackRetry {
    static DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];
    static STEADY_MS = 15000;

    /**
     * @param {object} o
     * @param {string} o.name       log prefix
     * @param {Element} o.container element the "Playback stopped" box goes in (position: relative)
     * @param {Function} o.run      reload the stream
     * @param {Function} [o.onWait] a retry is pending (show the spinner)
     * @param {Function} [o.onGiveUp] out of attempts (hide the spinner)
     */
    constructor({ name, container, run, onWait, onGiveUp }) {
        this.name = name;
        this.container = container;
        this.run = run;
        this.onWait = onWait || (() => {});
        this.onGiveUp = onGiveUp || (() => {});
        this.attempt = 0;
        this.key = null;
        this.timer = null;
        this.steadyTimer = null;
        this.parked = null; // reason, while waiting for online / visible
        this.box = null;

        this.resume = () => {
            if (!this.parked || !navigator.onLine || document.hidden) return;
            const reason = this.parked;
            this.parked = null;
            console.log(`[${this.name}] Online and visible again - retrying (${reason})`);
            this.fire(reason);
        };
        window.addEventListener('online', this.resume);
        document.addEventListener('visibilitychange', this.resume);
    }

    /** Playback failed: try again after the next delay, or give up */
    schedule(reason, key = null) {
        if (key !== this.key) {
            this.key = key;
            this.attempt = 0;
        }
        if (this.timer || this.parked) return; // one retry at a time
        clearTimeout(this.steadyTimer);
        if (Session.expired) return;
        if (this.attempt >= PlaybackRetry.DELAYS.length) return this.giveUp(reason);
        const delay = PlaybackRetry.DELAYS[this.attempt++];
        console.warn(`[${this.name}] ${reason} - retry ${this.attempt}/${PlaybackRetry.DELAYS.length} in ${delay}ms`);
        this.onWait();
        this.timer = setTimeout(() => {
            this.timer = null;
            this.fire(reason);
        }, delay);
    }

    async fire(reason) {
        if (!navigator.onLine || document.hidden) {
            console.log(`[${this.name}] ${navigator.onLine ? 'Page hidden' : 'Offline'} - retry waits`);
            this.parked = reason;
            return;
        }
        const token = this.token = {};
        const alive = await Session.check();
        if (token !== this.token) return; // cancelled meanwhile
        if (alive === false) return; // logged out: Session shows the notice
        if (alive === null) {
            // Server unreachable: counts as a failed attempt
            this.schedule(`${reason}, server unreachable`, this.key);
            return;
        }
        this.run();
    }

    /** Playing again: after STEADY_MS, a later failure starts from 1s again */
    playing() {
        this.hideBox();
        clearTimeout(this.steadyTimer);
        this.steadyTimer = setTimeout(() => { this.attempt = 0; }, PlaybackRetry.STEADY_MS);
    }

    /** Drop a pending or parked retry (a new load or stop took over) */
    cancel() {
        clearTimeout(this.timer);
        this.timer = null;
        this.parked = null;
        this.token = null;
        this.hideBox();
    }

    /** cancel() and forget the attempts (the user stopped or picked something else) */
    reset() {
        this.cancel();
        clearTimeout(this.steadyTimer);
        this.attempt = 0;
        this.key = null;
    }

    giveUp(reason) {
        console.error(`[${this.name}] Playback failed after ${PlaybackRetry.DELAYS.length} retries (${reason})`);
        this.onGiveUp();
        this.showBox();
    }

    showBox() {
        if (!this.container) return;
        if (!this.box) {
            this.box = document.createElement('div');
            this.box.className = 'playback-failed';
            this.box.innerHTML = `
                <p>Playback stopped. The stream didn't come back.</p>
                <button type="button" class="btn btn-primary">Retry</button>`;
            this.box.querySelector('button').addEventListener('click', (e) => {
                e.stopPropagation();
                this.attempt = 0;
                this.hideBox();
                this.onWait();
                this.fire('manual retry');
            });
            // Clicks on the box must not reach the player (play/pause, overlay)
            this.box.addEventListener('click', e => e.stopPropagation());
            this.container.appendChild(this.box);
        }
        this.box.hidden = false;
    }

    hideBox() {
        if (this.box) this.box.hidden = true;
    }
}

window.PlaybackRetry = PlaybackRetry;

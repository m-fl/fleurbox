/**
 * Guide Page Controller
 */

class GuidePage {
    constructor(app) {
        this.app = app;
    }

    async init() {
        // EPG guide will lazy load when shown
    }

    async show() {
        // The guide grid lists every channel, so it is the one view that loads
        // them all (Live TV fetches a group at a time)
        const channelList = this.app.channelList;
        try {
            await channelList.loadAllChannelsForGuide();
        } catch (err) {
            console.error('[Guide] Could not load channels:', err);
        }

        // Only load EPG data if not already loaded
        if (!this.app.epgGuide.programmes || this.app.epgGuide.programmes.length === 0) {
            await this.app.epgGuide.loadEpg();
        } else {
            // Just re-render with existing data (updates time position)
            this.app.epgGuide.render();
            this.app.epgGuide.startBackgroundRefresh();
        }
    }

    hide() {
        // The guide re-downloads its data every few minutes; only while it's shown
        this.app.epgGuide.stopBackgroundRefresh();
    }
}

window.GuidePage = GuidePage;

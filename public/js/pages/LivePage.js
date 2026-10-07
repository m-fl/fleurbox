/**
 * Live TV Page Controller
 */

class LivePage {
    constructor(app) {
        this.app = app;
        this.handleKeydown = this.handleKeydown.bind(this);
    }

    async init() {
        // Load sources and the group list on initial page load. "Now playing"
        // text comes from the server per group (no full EPG download).
        await this.app.channelList.loadSources();
        await this.app.channelList.loadChannels();
    }

    handleKeydown(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        switch (e.key) {
            case 'ArrowUp':
                // Check if player handles arrows for volume
                if (this.app.player && !this.app.player.settings.arrowKeysChangeChannel) return;

                e.preventDefault();
                this.app.channelList.selectPrevChannel();
                break;
            case 'ArrowDown':
                // Check if player handles arrows for volume
                if (this.app.player && !this.app.player.settings.arrowKeysChangeChannel) return;

                e.preventDefault();
                this.app.channelList.selectNextChannel();
                break;
        }
    }

    async show() {
        document.addEventListener('keydown', this.handleKeydown);

        // Only load if the group list isn't already loaded
        if (!this.app.channelList.loaded) {
            await this.app.channelList.loadSources();
            await this.app.channelList.loadChannels();
        }
    }

    hide() {
        document.removeEventListener('keydown', this.handleKeydown);
    }
}

window.LivePage = LivePage;

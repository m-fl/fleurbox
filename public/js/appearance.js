// Appearance from Profile (ProfilePage.applyAppearance), applied before the
// first paint. A file rather than an inline <script>: the Content-Security-
// Policy only allows scripts from this site.
try {
    var a = JSON.parse(localStorage.getItem('fleurbox_appearance') || '{}'), r = document.documentElement;
    ['accent', 'textSize', 'motion'].forEach(function (k) { if (a[k]) r.dataset[k] = a[k]; });
} catch (e) { }

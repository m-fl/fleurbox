/**
 * Log redaction
 * Xtream providers embed credentials in stream URLs, both in the path
 * (/movie/<user>/<pass>/123.mkv) and in query strings (xmltv.php?username=&password=).
 * Pass anything that may contain such a URL through redact() before logging it.
 */

function redact(value) {
    return String(value)
        .replace(/\/(live|movie|series|timeshift)\/[^/\s]+\/[^/\s]+\//g, '/$1/***/***/')
        .replace(/([?&](?:username|password|user|pass|token)=)[^&\s]*/gi, '$1***')
        .replace(/(:\/\/)[^/@\s]+@/g, '$1***@');
}

module.exports = { redact };

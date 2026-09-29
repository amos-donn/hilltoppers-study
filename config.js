/* Deployment settings for Hilltoppers Study.
 *
 * STUDYSTREAM_API is the base URL of the Worker that hands out lookup codes
 * and authorizes rooms. It is empty by default, which would make the app show
 * its offline screen. Set it before publishing:
 */
window.STUDYSTREAM_API = 'https://hilltoppers-study.amos-donn.workers.dev';

/* Relay (TURN) servers for the WebRTC handshake.
 *
 * Leave this empty. The Worker hands out short-lived relay credentials at
 * /api/turn, and the app merges them in automatically. That is what lets two
 * students on a network that blocks peer-to-peer still connect.
 *
 * If you set config.iceServers here instead, the app uses yours and skips the
 * Worker. That is only useful for a fixed, self-hosted TURN server.
 */
window.STUDYSTREAM_PEER = {};

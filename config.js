/* Deployment settings for Hilltoppers Study.
 *
 * STUDYSTREAM_API is the base URL of the Worker that signs students in and
 * authorizes rooms. It is empty by default, which would make the app show its
 * offline screen. Set it before publishing:
 */
window.STUDYSTREAM_API = 'https://hilltoppers-study.amos-donn.workers.dev';

/* The Hilltoppers Firebase project. Study does not create accounts or store
 * passwords: it signs in against the same project the Hilltoppers extension
 * uses, so a student keeps the same email and password. These values identify
 * the project publicly (Google publishes web config in page source) and are
 * safe to commit; the Firebase project's own rules protect the data.
 *
 * The project id must match what the Worker verifies tokens against. */
window.STUDYSTREAM_FIREBASE = {
  apiKey: 'AIzaSyCPDKZHahJOA2WIJaOaYDYDcxFNAW2oUK0',
  projectId: 'schedule-59d28'
};

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

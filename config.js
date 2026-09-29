/* Deployment settings for StudyStream.
 *
 * STUDYSTREAM_API is the base URL of the Worker that hands out lookup codes
 * and authorizes rooms. It is empty by default, which would make the app show
 * its offline screen. Set it before publishing:
 */
window.STUDYSTREAM_API = 'https://hilltoppers-study.amos-donn.workers.dev';

/* Set to '' to keep using the public PeerJS cloud for the WebRTC handshake. */
window.STUDYSTREAM_PEER = {};

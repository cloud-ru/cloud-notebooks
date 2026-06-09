import * as https from "node:https";
import * as tls from "node:tls";

interface CaCapableTls {
  getCACertificates?: (type: "default" | "system" | "bundled") => string[];
}

/**
 * HTTPS agent for the shim's upstream notebook requests.
 *
 * Node ships its own CA list and does NOT trust the OS keychain, so in corporate networks with TLS
 * inspection (a re-signing proxy whose root CA lives in the keychain) browsers/curl succeed but Node
 * fails the handshake. We add the system CA store (Node 22.15+ `tls.getCACertificates`) to the bundled
 * roots so those certificates are trusted. `tlsVerify=false` disables verification entirely as a last
 * resort.
 */
export function createUpstreamAgent(tlsVerify: boolean): https.Agent {
  const options: https.AgentOptions = { keepAlive: true, rejectUnauthorized: tlsVerify };
  const getCertificates = (tls as unknown as CaCapableTls).getCACertificates;
  if (tlsVerify && typeof getCertificates === "function") {
    try {
      options.ca = [...getCertificates("default"), ...getCertificates("system")];
    } catch {
      // Older Node or unsupported platform — fall back to the bundled roots.
    }
  }
  return new https.Agent(options);
}

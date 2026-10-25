import dns from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';

// Addresses a public monitoring service must never fetch: loopback, private LANs, link-local (cloud metadata
// lives at 169.254.169.254), carrier-grade NAT, multicast/reserved, and their IPv6 equivalents.
const BLOCKED = new net.BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  BLOCKED.addSubnet(ip, bits, 'ipv4');
}
for (const [ip, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  BLOCKED.addSubnet(ip, bits, 'ipv6');
}

export function isBlockedAddress(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);   // ::ffff:127.0.0.1 is 127.0.0.1 in disguise
  if (mapped) return BLOCKED.check(mapped[1], 'ipv4');
  return net.isIPv6(ip) ? BLOCKED.check(ip, 'ipv6') : BLOCKED.check(ip, 'ipv4');
}

export class BlockedTargetError extends Error {
  code = 'EBLOCKED';
}

// Decides which URLs the worker may fetch. Disabled (the default) for local dev, where targets ARE private.
// allowedHosts: exact hostnames that may resolve privately anyway (e.g. our own "demo-targets" container).
export function createTargetPolicy({ blockPrivate = false, allowedHosts = [] } = {}) {
  const allowed = new Set(allowedHosts.map(h => h.toLowerCase()));
  const exempt = hostname => !blockPrivate || allowed.has(hostname.toLowerCase());

  // Runs INSIDE the connection: the address we validate is the address we connect to. Checking DNS once at
  // registration isn't enough: a domain can resolve to a public IP then, and to 192.168.1.1 later
  // (DNS rebinding). Hooking the connect-time lookup closes that gap.
  function guardedLookup(hostname, options, callback) {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const bad = addresses.find(a => isBlockedAddress(a.address));
      if (bad && !exempt(hostname)) return callback(new BlockedTargetError(`blocked internal address ${bad.address}`));
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  }

  return {
    enabled: blockPrivate,
    // Only needed when blocking: a dispatcher whose sockets resolve through guardedLookup.
    dispatcher: blockPrivate ? new Agent({ connect: { lookup: guardedLookup } }) : undefined,

    // Fast check at registration time (good error message) and before every probe.
    // IP literals (http://10.0.0.1) never go through DNS lookup, so they must be checked here.
    async check(rawUrl) {
      const { hostname } = new URL(rawUrl);
      const host = hostname.replace(/^\[|\]$/g, '');   // [::1] → ::1
      if (exempt(host)) return;
      if (net.isIP(host)) {
        if (isBlockedAddress(host)) throw new BlockedTargetError(`blocked internal address ${host}`);
        return;
      }
      const addresses = await dns.promises.lookup(host, { all: true }).catch(() => []);   // unresolvable: probe will report it
      const bad = addresses.find(a => isBlockedAddress(a.address));
      if (bad) throw new BlockedTargetError(`${host} resolves to blocked internal address ${bad.address}`);
    },
  };
}

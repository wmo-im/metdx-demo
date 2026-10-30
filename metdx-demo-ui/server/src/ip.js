import net from 'node:net';

const blocked = new net.BlockList();

const V4 = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3], // multicast + reserved + broadcast
];
for (const [addr, prefix] of V4) blocked.addSubnet(addr, prefix, 'ipv4');

const V6 = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64
  ['100::', 64], // discard
  ['2001:db8::', 32],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];
for (const [addr, prefix] of V6) blocked.addSubnet(addr, prefix, 'ipv6');

/**
 * True when the address is loopback / private / link-local / otherwise not
 * a public unicast address. Unparseable input is treated as private.
 * @param {string} address
 */
export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1], 'ipv4');
    // Hex form of IPv4-mapped, e.g. ::ffff:7f00:1
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
    }
    return blocked.check(address, 'ipv6');
  }
  return true;
}

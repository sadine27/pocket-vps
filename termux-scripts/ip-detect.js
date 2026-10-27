// Prints the local LAN IP by inspecting an outbound socket (no netlink needed)
const net = require('net');
const s = net.connect({ host: '1.1.1.1', port: 443, family: 4 }, () => {
  console.log(s.localAddress);
  s.destroy();
});
s.on('error', () => process.exit(1));
setTimeout(() => process.exit(1), 10000);

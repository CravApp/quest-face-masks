// HTTPS autofirmado para que el visor abra el dev server por la IP de la LAN.
// getUserMedia y WebXR exigen contexto seguro; http://IP no lo es.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generate } from 'selfsigned';
import type { Plugin } from 'vite';

const CERT_DIR = path.resolve('node_modules/.vite/lan-ssl');

export function lanIPv4(): string[] {
  const ips: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const net of addrs ?? []) {
      const family = String(net.family);
      if (family !== 'IPv4' && family !== '4') continue;
      if (net.internal || net.address.startsWith('169.254.')) continue;
      ips.push(net.address);
    }
  }
  return [...new Set(ips)];
}

function altNames(ips: string[]) {
  const names: { type: 2 | 7; value?: string; ip?: string }[] = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: '::1' },
  ];
  const host = os.hostname();
  if (host) names.push({ type: 2, value: host });
  for (const ip of ips) names.push({ type: 7, ip });
  return names;
}

async function ensureCert(ips: string[]): Promise<{ key: string; cert: string }> {
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const metaFile = path.join(CERT_DIR, 'meta.json');
  const fingerprint = JSON.stringify([...ips].sort());
  try {
    const meta = await readFile(metaFile, 'utf8');
    if (JSON.parse(meta).ips === fingerprint) {
      return { key: await readFile(keyFile, 'utf8'), cert: await readFile(certFile, 'utf8') };
    }
  } catch {
    // se genera debajo
  }
  const notAfter = new Date();
  notAfter.setDate(notAfter.getDate() + 365);
  const pems = await generate([{ name: 'commonName', value: 'quest-face-masks' }], {
    algorithm: 'sha256',
    keySize: 2048,
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: altNames(ips) },
    ],
  });
  await mkdir(CERT_DIR, { recursive: true });
  await writeFile(keyFile, pems.private);
  await writeFile(certFile, pems.cert);
  await writeFile(metaFile, JSON.stringify({ ips: fingerprint }));
  return { key: pems.private, cert: pems.cert };
}

/** Activa TLS en el dev server y escribe las URL https de la LAN. */
export function lanHttpsPlugin(): Plugin {
  return {
    name: 'quest-lan-https',
    apply: 'serve',
    async config() {
      const { key, cert } = await ensureCert(lanIPv4());
      return { server: { https: { key, cert }, host: true } };
    },
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        setTimeout(() => {
          const addr = server.httpServer?.address();
          const port = typeof addr === 'object' && addr ? addr.port : (server.config.server.port ?? 5173);
          const ips = lanIPv4();
          const lines = ['', '  Quest por Wi-Fi (HTTPS autofirmado; acepta el aviso en el visor):'];
          if (ips.length === 0) lines.push('  (no se detectó una IPv4 de LAN)');
          for (const ip of ips) lines.push(`  https://${ip}:${port}/`);
          lines.push('');
          server.config.logger.info(lines.join('\n'));
        }, 30);
      });
    },
  };
}

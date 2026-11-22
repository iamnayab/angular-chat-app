import { Injectable } from '@angular/core';
import { MessagePayloadData, ReplyQuote } from '../models/chat.models';

@Injectable({
  providedIn: 'root'
})
export class CryptoService {
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  // Expected SHA-256 hash for PIN "0202"
  public readonly AUTH_SECRET_HASH = '3472adbbcb9677d1b45365d37d96d1c33217d745567577fd9bd5c2766a258320';

  async computeHash(value: string): Promise<string> {
    const buf = await crypto.subtle.digest('SHA-256', this.encoder.encode(value));
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async deriveKey(password: string, roomId: string): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey(
      'raw',
      this.encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: this.encoder.encode('PrivateRoom-v1:' + roomId),
        iterations: 310000,
        hash: 'SHA-256'
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async encryptMessage(
    data: string | MessagePayloadData,
    key: CryptoKey
  ): Promise<{ iv: string; ciphertext: string }> {
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      this.encoder.encode(raw)
    );

    return {
      iv: this.bytesToBase64(iv),
      ciphertext: this.bytesToBase64(new Uint8Array(encrypted))
    };
  }

  async decryptMessage(
    payload: { iv: string; ciphertext: string },
    key: CryptoKey
  ): Promise<{ text: string; replyTo?: ReplyQuote }> {
    const clear = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: this.base64ToBytes(payload.iv) },
      key,
      this.base64ToBytes(payload.ciphertext)
    );
    const decoded = this.decoder.decode(clear);
    try {
      const parsed = JSON.parse(decoded);
      if (parsed && typeof parsed.text === 'string') {
        return { text: parsed.text, replyTo: parsed.replyTo };
      }
    } catch {}
    return { text: decoded };
  }

  async encryptBuffer(buffer: ArrayBuffer, key: CryptoKey): Promise<{ iv: string; ciphertext: ArrayBuffer }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      buffer
    );
    return {
      iv: this.bytesToBase64(iv),
      ciphertext
    };
  }

  async decryptBuffer(encryptedBuffer: ArrayBuffer, ivBase64: string, key: CryptoKey): Promise<ArrayBuffer> {
    const ivBytes = this.base64ToBytes(ivBase64);
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes },
      key,
      encryptedBuffer
    );
  }

  bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  base64ToBytes(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}

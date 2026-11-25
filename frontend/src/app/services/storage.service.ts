import { Injectable } from '@angular/core';
import { EncryptedPayload, Role } from '../models/chat.models';

@Injectable({
  providedIn: 'root'
})
export class StorageService {
  private readonly STORAGE_CACHE_KEY = 'private_space_history';
  private readonly CACHE_NAME = 'private-chat-ephemeral-v1';

  getLocalMessages(): EncryptedPayload[] {
    try {
      const legacyKey = Object.keys(localStorage).find(k => k.endsWith('_history') && k !== this.STORAGE_CACHE_KEY);
      if (legacyKey) {
        const legacyData = localStorage.getItem(legacyKey);
        if (legacyData) {
          localStorage.setItem(this.STORAGE_CACHE_KEY, legacyData);
          localStorage.removeItem(legacyKey);
          return JSON.parse(legacyData);
        }
      }
      return JSON.parse(localStorage.getItem(this.STORAGE_CACHE_KEY) || '[]');
    } catch {
      return [];
    }
  }

  saveLocalMessage(msg: EncryptedPayload): void {
    try {
      const existing = this.getLocalMessages();
      const idx = existing.findIndex(m => (m.id && msg.id && m.id === msg.id) || m.ciphertext === msg.ciphertext);
      if (idx >= 0) {
        existing[idx] = { ...existing[idx], ...msg };
      } else {
        existing.push(msg);
      }
      if (existing.length > 1500) existing.shift();
      localStorage.setItem(this.STORAGE_CACHE_KEY, JSON.stringify(existing));
    } catch (e) {
      console.warn('Could not save to local storage cache:', e);
    }
  }

  updateLocalMessagesSeen(myRole: Role): void {
    try {
      const existing = this.getLocalMessages();
      let changed = false;
      existing.forEach(m => {
        if (m.senderRole === myRole && !m.seen) {
          m.seen = true;
          changed = true;
        }
      });
      if (changed) {
        localStorage.setItem(this.STORAGE_CACHE_KEY, JSON.stringify(existing));
      }
    } catch {}
  }

  deleteLocalMessages(messageIds: string[]): void {
    try {
      const existing = this.getLocalMessages();
      const idSet = new Set(messageIds);
      const filtered = existing.filter(m => !idSet.has(m.id));
      localStorage.setItem(this.STORAGE_CACHE_KEY, JSON.stringify(filtered));
    } catch (e) {
      console.warn('Could not delete messages from local cache:', e);
    }
  }

  clearLocalMessages(): void {
    try {
      localStorage.removeItem(this.STORAGE_CACHE_KEY);
      Object.keys(localStorage).forEach(k => {
        if (k.endsWith('_history') || k.includes('history') || k.includes('private_space')) {
          localStorage.removeItem(k);
        }
      });
    } catch {}
  }

  async storeInBrowserCache(id: string, blob: Blob, fileName: string, mimeType: string): Promise<void> {
    if (!('caches' in window)) return;
    try {
      const cache = await caches.open(this.CACHE_NAME);
      const headers = new Headers();
      headers.set('Content-Type', mimeType || 'application/octet-stream');
      headers.set('X-File-Name', encodeURIComponent(fileName || 'attachment'));
      headers.set('X-Saved-At', String(Date.now()));
      const response = new Response(blob, { headers });
      await cache.put(`/ephemeral-attachments/${id}`, response);
    } catch (e) {
      console.warn('Could not cache ephemeral blob:', e);
    }
  }

  async clearBrowserCache(): Promise<void> {
    if (!('caches' in window)) return;
    try {
      await caches.delete(this.CACHE_NAME);
    } catch {}
  }
}

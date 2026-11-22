import {
  Component,
  OnInit,
  OnDestroy,
  ElementRef,
  ViewChild,
  HostListener,
  AfterViewChecked
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';

import {
  Role,
  DisplayMessage,
  EncryptedPayload,
  AttachmentMeta,
  ReplyQuote,
  MessagePayloadData,
  ActiveCall
} from './models/chat.models';
import { CryptoService } from './services/crypto.service';
import { SocketService } from './services/socket.service';
import { StorageService } from './services/storage.service';
import { AudioService } from './services/audio.service';
import { WebRtcService } from './services/webrtc.service';

const CHUNK_SIZE = 64 * 1024; // 64 KB chunks for socket streaming
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB max limit

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit, OnDestroy, AfterViewChecked {
  @ViewChild('messagesContainer') private messagesContainer!: ElementRef<HTMLDivElement>;
  @ViewChild('fileInput') private fileInput!: ElementRef<HTMLInputElement>;
  @ViewChild('messageInputField') private messageInputField!: ElementRef<HTMLInputElement>;
  @ViewChild('localVideoRef') private localVideoRef?: ElementRef<HTMLVideoElement>;
  @ViewChild('remoteVideoRef') private remoteVideoRef?: ElementRef<HTMLVideoElement>;

  // Stage: 'unlock' -> 'role' -> 'chat'
  currentStage: 'unlock' | 'role' | 'chat' = 'unlock';

  // Unlock credentials
  roomIdInput = '';
  passwordInput = '';
  joinError = '';
  isVerifying = false;

  // Active Chat State
  activeRoomId = '';
  myRole: Role | '' = '';
  encryptionKey: CryptoKey | null = null;
  isJoiningRole = false;
  roleJoiningTarget: Role | '' = '';
  identityError = '';

  // Presence & Info
  isPartnerOnline = false;
  partnerLastSeen: number | null = null;
  peopleCount = 1;
  connectionText = 'Connecting…';

  // Chat messages
  messages: DisplayMessage[] = [];
  draftMessage = '';

  // Reply State (WhatsApp Style)
  replyingTo: ReplyQuote | null = null;

  // Edit State
  editingMessage: DisplayMessage | null = null;

  // Swipe-to-reply gesture state
  touchStartX = 0;
  activeSwipeMsgId: string | null = null;
  swipeOffset = 0;

  // Typing
  isTypingIndicatorVisible = false;
  typingPartnerName = 'Partner';
  private typingTimeout: any = null;
  private isCurrentlyTyping = false;

  // Manual Ring
  isRingingPartner = false;
  ringButtonText = '🔔 Ring';

  // Attachment Staging & Preview
  showPreviewModal = false;
  stagedFile: File | null = null;
  stagedFilePreviewUrl: string | null = null;
  stagedFileIsImage = false;
  stagedFileName = '';
  stagedFileMetaText = '';
  stagedFileIcon = '📎';
  isSendingAttachment = false;
  attachmentModalError = '';

  // Lightbox
  showLightbox = false;
  lightboxUrl = '';
  lightboxTitle = '';

  // Drag & drop
  isDragOver = false;

  // WebRTC Audio / Video Calling
  activeCall: ActiveCall | null = null;
  private incomingOffer: any = null;
  private attachedLocalStream: MediaStream | null = null;
  private attachedRemoteStream: MediaStream | null = null;

  // Ephemeral in-flight tracking
  private inFlightIncoming = new Map<
    string,
    {
      meta: AttachmentMeta;
      chunks: string[];
      receivedCount: number;
      messageRef: DisplayMessage;
    }
  >();
  private ephemeralBlobs = new Map<string, { blobUrl: string; blob: Blob; fileName: string }>();

  private subs = new Subscription();
  private relativeTimeInterval: any = null;

  constructor(
    private cryptoService: CryptoService,
    private socketService: SocketService,
    private storageService: StorageService,
    private audioService: AudioService,
    public webrtcService: WebRtcService
  ) {}

  ngOnInit(): void {
    this.setupSocketSubscriptions();
    this.setupWebRtcSubscriptions();

    this.relativeTimeInterval = setInterval(() => {
      if (this.currentStage === 'chat' && !this.isPartnerOnline && this.partnerLastSeen) {
        this.updatePresenceText();
      }
    }, 30000);
  }

  ngAfterViewChecked(): void {
    this.syncVideoStreams();
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    if (this.relativeTimeInterval) clearInterval(this.relativeTimeInterval);
    this.clearAllBlobs();
  }

  // -------------------------------------------------------------
  // Keyboard & Clipboard Listeners
  // -------------------------------------------------------------
  @HostListener('document:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (this.showLightbox) this.closeLightbox();
      if (this.showPreviewModal) this.closePreviewModal();
      if (this.editingMessage) this.cancelEdit();
      if (this.replyingTo) this.cancelReply();
    }
  }

  @HostListener('document:paste', ['$event'])
  handlePasteEvent(event: ClipboardEvent): void {
    if (this.currentStage !== 'chat') return;
    const items = event.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const file = items[i].getAsFile();
        if (file) {
          this.handleFileSelection(file);
          break;
        }
      }
    }
  }

  // -------------------------------------------------------------
  // Step 1: Unlock with 4-Digit Room ID & Password
  // -------------------------------------------------------------
  async onUnlockSubmit(): Promise<void> {
    this.joinError = '';
    const room = this.roomIdInput.trim();
    const pass = this.passwordInput.trim();

    if (!room || !pass) {
      this.joinError = 'Please enter both Room ID and Password.';
      return;
    }

    this.isVerifying = true;

    try {
      const [roomH, passH] = await Promise.all([
        this.cryptoService.computeHash(room),
        this.cryptoService.computeHash(pass)
      ]);

      if (
        roomH !== this.cryptoService.AUTH_SECRET_HASH ||
        passH !== this.cryptoService.AUTH_SECRET_HASH
      ) {
        this.joinError = '❌ Invalid Room ID or Password. Access denied.';
        this.isVerifying = false;
        return;
      }

      this.encryptionKey = await this.cryptoService.deriveKey(pass, room);
      this.activeRoomId = room;

      // Clear input fields immediately for privacy
      this.roomIdInput = '';
      this.passwordInput = '';
      this.isVerifying = false;

      // Transition to Role Selection
      this.currentStage = 'role';
    } catch (err: any) {
      this.isVerifying = false;
      this.joinError = 'Encryption error: ' + (err.message || err);
    }
  }

  // -------------------------------------------------------------
  // Step 2: Role Selection (Harry vs Elira)
  // -------------------------------------------------------------
  async onChooseRole(role: Role): Promise<void> {
    if (this.isJoiningRole) return;

    this.isJoiningRole = true;
    this.roleJoiningTarget = role;
    this.identityError = '';

    try {
      const res = await this.socketService.joinRoom(this.activeRoomId, role);

      this.isJoiningRole = false;
      this.roleJoiningTarget = '';

      if (!res?.ok) {
        this.identityError = res?.error || 'Could not enter room.';
        return;
      }

      this.myRole = role;
      this.currentStage = 'chat';

      this.partnerLastSeen = res.partnerLastSeen ? Number(res.partnerLastSeen) : null;
      this.updatePresenceUI(res.count || 1, Boolean(res.partnerOnline));

      // Load & Decrypt Chat History
      await this.loadAndDecryptHistory(res.history || []);

      // Mark unread partner messages as seen
      this.socketService.markSeen();

      // Focus message input
      setTimeout(() => {
        this.messageInputField?.nativeElement?.focus();
        this.scrollToBottom();
      }, 100);
    } catch (err: any) {
      this.isJoiningRole = false;
      this.roleJoiningTarget = '';
      this.identityError = 'Server error joining room: ' + (err.message || err);
    }
  }

  // -------------------------------------------------------------
  // Chat History Decryption & Synchronization
  // -------------------------------------------------------------
  private async loadAndDecryptHistory(serverMsgs: EncryptedPayload[]): Promise<void> {
    if (!this.encryptionKey) return;

    const localMsgs = this.storageService.getLocalMessages();
    const combined: EncryptedPayload[] = [...localMsgs];

    for (const sm of serverMsgs) {
      const existing = combined.find(
        m => (m.id && sm.id && m.id === sm.id) || m.ciphertext === sm.ciphertext
      );
      if (existing) {
        existing.seen = Boolean(existing.seen || sm.seen);
        existing.sentAt = Number(sm.sentAt) || Number(existing.sentAt) || Date.now();
        existing.id = sm.id || existing.id;
        existing.editedAt = sm.editedAt ? Number(sm.editedAt) : existing.editedAt;
        this.storageService.saveLocalMessage(existing);
      } else {
        const item: EncryptedPayload = {
          ...sm,
          sentAt: Number(sm.sentAt) || Date.now(),
          seen: Boolean(sm.seen),
          editedAt: sm.editedAt ? Number(sm.editedAt) : undefined
        };
        combined.push(item);
        this.storageService.saveLocalMessage(item);
      }
    }

    combined.sort((a, b) => (Number(a.sentAt) || 0) - (Number(b.sentAt) || 0));

    const decryptedList = await Promise.all(
      combined.map(async msg => {
        try {
          const decrypted = await this.cryptoService.decryptMessage(msg, this.encryptionKey!);
          return {
            id: msg.id,
            senderRole: msg.senderRole,
            sentAt: Number(msg.sentAt) || Date.now(),
            text: decrypted.text,
            replyTo: decrypted.replyTo,
            seen: msg.seen,
            isEdited: Boolean(msg.editedAt),
            editedAt: msg.editedAt ? Number(msg.editedAt) : undefined
          } as DisplayMessage;
        } catch {
          return null;
        }
      })
    );

    this.messages = decryptedList.filter(m => m !== null) as DisplayMessage[];
  }

  // -------------------------------------------------------------
  // Messaging & Editing & Replying
  // -------------------------------------------------------------
  async handleComposerSubmit(): Promise<void> {
    if (this.editingMessage) {
      await this.saveEditedMessage();
    } else {
      await this.sendMessage();
    }
  }

  async sendMessage(): Promise<void> {
    const text = this.draftMessage.trim();
    if (!text || !this.encryptionKey || !this.myRole) return;

    this.draftMessage = '';

    if (this.isCurrentlyTyping) {
      this.isCurrentlyTyping = false;
      clearTimeout(this.typingTimeout);
      this.socketService.sendTyping(false);
    }

    const replySnapshot = this.replyingTo ? { ...this.replyingTo } : undefined;
    this.replyingTo = null;

    try {
      const payloadData: MessagePayloadData = {
        text,
        replyTo: replySnapshot
      };

      const encrypted = await this.cryptoService.encryptMessage(payloadData, this.encryptionKey);
      const sentAt = Date.now();
      const id = crypto.randomUUID ? crypto.randomUUID() : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      const msgObj: EncryptedPayload = {
        id,
        roomId: this.activeRoomId || '0202',
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        senderRole: this.myRole as Role,
        sentAt,
        seen: false
      };

      // Push locally immediately
      this.messages.push({
        id,
        senderRole: this.myRole as Role,
        sentAt,
        text,
        replyTo: replySnapshot,
        seen: false
      });
      this.storageService.saveLocalMessage(msgObj);
      this.scrollToBottom();

      this.socketService.sendChatMessage(msgObj);
    } catch (err) {
      console.error('Send message error:', err);
      this.addSystemNote('Failed to encrypt message.');
    }
  }

  async saveEditedMessage(): Promise<void> {
    const newText = this.draftMessage.trim();
    const msg = this.editingMessage;
    if (!newText || !msg || !this.encryptionKey || !this.myRole) return;

    const editedAt = Date.now();

    try {
      const payloadData: MessagePayloadData = {
        text: newText,
        replyTo: msg.replyTo
      };

      const encrypted = await this.cryptoService.encryptMessage(payloadData, this.encryptionKey);

      const editedPayload: EncryptedPayload = {
        id: msg.id,
        roomId: this.activeRoomId || '0202',
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        senderRole: this.myRole as Role,
        sentAt: msg.sentAt,
        editedAt
      };

      // Update message in local view
      msg.text = newText;
      msg.isEdited = true;
      msg.editedAt = editedAt;
      this.storageService.saveLocalMessage(editedPayload);

      // Reset edit state
      this.editingMessage = null;
      this.draftMessage = '';

      // Emit edit to server
      await this.socketService.editChatMessage(editedPayload);
    } catch (err) {
      console.error('Failed to save edited message:', err);
      this.addSystemNote('Could not update edited message.');
    }
  }

  startEdit(msg: DisplayMessage): void {
    if (msg.senderRole !== this.myRole || msg.isAttachment || msg.isSystem) return;
    this.cancelReply();
    this.editingMessage = msg;
    this.draftMessage = msg.text || '';
    setTimeout(() => this.messageInputField?.nativeElement?.focus(), 50);
  }

  cancelEdit(): void {
    this.editingMessage = null;
    this.draftMessage = '';
  }

  // -------------------------------------------------------------
  // Swipe Right to Reply (WhatsApp Style)
  // -------------------------------------------------------------
  onTouchStart(event: TouchEvent, msg: DisplayMessage): void {
    if (msg.isSystem) return;
    this.touchStartX = event.touches[0].clientX;
    this.activeSwipeMsgId = msg.id;
    this.swipeOffset = 0;
  }

  onTouchMove(event: TouchEvent, msg: DisplayMessage): void {
    if (this.activeSwipeMsgId !== msg.id) return;
    const currentX = event.touches[0].clientX;
    const deltaX = currentX - this.touchStartX;
    if (deltaX > 0) {
      this.swipeOffset = Math.min(deltaX * 0.75, 75);
    }
  }

  onTouchEnd(event: TouchEvent, msg: DisplayMessage): void {
    if (this.activeSwipeMsgId !== msg.id) return;
    if (this.swipeOffset >= 45) {
      if ('vibrate' in navigator) navigator.vibrate(30);
      this.setReplyTo(msg);
    }
    this.swipeOffset = 0;
    this.activeSwipeMsgId = null;
  }

  setReplyTo(msg: DisplayMessage): void {
    this.cancelEdit();
    let snippet = msg.text || '';
    if (msg.isAttachment) {
      snippet = msg.attachment?.meta.isImage ? '🖼️ Photo' : `📎 ${msg.attachment?.meta.fileName || 'Attachment'}`;
    }

    this.replyingTo = {
      id: msg.id,
      senderRole: msg.senderRole || (this.myRole as Role),
      text: snippet
    };

    setTimeout(() => this.messageInputField?.nativeElement?.focus(), 50);
  }

  cancelReply(): void {
    this.replyingTo = null;
  }

  scrollToMessage(msgId: string): void {
    const el = document.getElementById(`msg-${msgId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('highlight-bubble');
      setTimeout(() => el.classList.remove('highlight-bubble'), 1400);
    }
  }

  onMessageInput(): void {
    const hasText = this.draftMessage.trim().length > 0;
    if (hasText) {
      if (!this.isCurrentlyTyping) {
        this.isCurrentlyTyping = true;
        this.socketService.sendTyping(true);
      }
      clearTimeout(this.typingTimeout);
      this.typingTimeout = setTimeout(() => {
        this.isCurrentlyTyping = false;
        this.socketService.sendTyping(false);
      }, 2500);
    } else {
      if (this.isCurrentlyTyping) {
        this.isCurrentlyTyping = false;
        clearTimeout(this.typingTimeout);
        this.socketService.sendTyping(false);
      }
    }
  }

  // -------------------------------------------------------------
  // WebRTC Audio & Video Calling
  // -------------------------------------------------------------
  private setupWebRtcSubscriptions(): void {
    this.subs.add(
      this.webrtcService.activeCall$.subscribe((call) => {
        this.activeCall = call;
      })
    );

    this.subs.add(
      this.socketService.incomingCall$.subscribe((incoming) => {
        this.incomingOffer = incoming.offer;
        this.audioService.playRingChime();
      })
    );
  }

  private syncVideoStreams(): void {
    const localStream = this.webrtcService.localStream$.value;
    const remoteStream = this.webrtcService.remoteStream$.value;

    if (this.localVideoRef?.nativeElement && localStream && this.attachedLocalStream !== localStream) {
      this.localVideoRef.nativeElement.srcObject = localStream;
      this.attachedLocalStream = localStream;
    }

    if (this.remoteVideoRef?.nativeElement && remoteStream && this.attachedRemoteStream !== remoteStream) {
      this.remoteVideoRef.nativeElement.srcObject = remoteStream;
      this.attachedRemoteStream = remoteStream;
    }
  }

  startCall(type: 'audio' | 'video'): void {
    if (this.currentStage !== 'chat') return;
    if (!this.isPartnerOnline) {
      const partner = this.myRole === 'he' ? 'Elira' : 'Harry';
      alert(`${partner} is offline right now. Cannot start call.`);
      return;
    }
    const partnerRole = this.myRole === 'he' ? 'she' : 'he';
    this.webrtcService.startCall(partnerRole, type === 'video');
  }

  acceptIncomingCall(): void {
    if (this.incomingOffer) {
      this.webrtcService.acceptCall(this.incomingOffer);
      this.incomingOffer = null;
    }
  }

  rejectIncomingCall(): void {
    this.incomingOffer = null;
    this.webrtcService.rejectCall();
  }

  endActiveCall(): void {
    this.webrtcService.endCall();
  }

  toggleCallAudio(): void {
    this.webrtcService.toggleAudio();
  }

  toggleCallVideo(): void {
    this.webrtcService.toggleVideo();
  }

  // -------------------------------------------------------------
  // Socket Subscriptions
  // -------------------------------------------------------------
  private setupSocketSubscriptions(): void {
    // 1. Reconnect
    this.subs.add(
      this.socketService.connect$.subscribe(() => {
        if (this.currentStage === 'chat' && this.encryptionKey && this.myRole && this.activeRoomId) {
          this.socketService.joinRoom(this.activeRoomId, this.myRole).then(() => {
            console.log('Reconnected to room seamlessly.');
            this.socketService.markSeen();
          });
        }
      })
    );

    // 2. Incoming Chat Message
    this.subs.add(
      this.socketService.chatMessage$.subscribe(async payload => {
        if (!this.encryptionKey) return;
        try {
          const decrypted = await this.cryptoService.decryptMessage(payload, this.encryptionKey);
          const sentAt = Number(payload.sentAt) || Date.now();

          this.messages.push({
            id: payload.id,
            senderRole: payload.senderRole,
            sentAt,
            text: decrypted.text,
            replyTo: decrypted.replyTo,
            seen: false
          });

          this.storageService.saveLocalMessage({ ...payload, sentAt });
          this.isTypingIndicatorVisible = false;
          this.scrollToBottom();

          // Acknowledge read receipt
          this.socketService.markSeen();
        } catch (err) {
          console.warn('Failed to decrypt incoming message:', err);
        }
      })
    );

    // 3. Message Edited by Partner
    this.subs.add(
      this.socketService.messageEdited$.subscribe(async payload => {
        if (!this.encryptionKey) return;
        const existing = this.messages.find(m => m.id === payload.id);
        if (existing) {
          try {
            const decrypted = await this.cryptoService.decryptMessage(payload, this.encryptionKey);
            existing.text = decrypted.text;
            if (decrypted.replyTo) existing.replyTo = decrypted.replyTo;
            existing.isEdited = true;
            existing.editedAt = Number(payload.editedAt) || Date.now();
            this.storageService.saveLocalMessage(payload);
          } catch (err) {
            console.warn('Failed to decrypt edited message:', err);
          }
        }
      })
    );

    // 4. Messages Seen Receipt
    this.subs.add(
      this.socketService.messagesSeen$.subscribe(({ seenBy }) => {
        if (seenBy !== this.myRole) {
          this.messages.forEach(m => {
            if (m.senderRole === this.myRole && !m.seen) {
              m.seen = true;
            }
          });
          if (this.myRole) this.storageService.updateLocalMessagesSeen(this.myRole);
        }
      })
    );

    // 5. Partner Presence & Count
    this.subs.add(
      this.socketService.userStatus$.subscribe(({ role, isOnline, lastSeen }) => {
        if (role !== this.myRole) {
          this.isPartnerOnline = Boolean(isOnline);
          if (lastSeen) this.partnerLastSeen = Number(lastSeen);
          this.updatePresenceUI(isOnline ? 2 : 1, isOnline);
          if (isOnline) this.socketService.markSeen();
        }
      })
    );

    this.subs.add(
      this.socketService.roomCount$.subscribe(count => {
        this.updatePresenceUI(count, count === 2);
      })
    );

    // 6. Incoming Ring Alert
    this.subs.add(
      this.socketService.incomingRing$.subscribe(({ fromName }) => {
        this.addSystemNote(`🔔 ${fromName || 'Partner'} is ringing your phone!`);
        this.audioService.playRingChime();
      })
    );

    // 7. Typing Indicator
    this.subs.add(
      this.socketService.typing$.subscribe(({ role, isTyping }) => {
        if (role !== this.myRole) {
          this.typingPartnerName = role === 'he' ? 'Harry' : 'Elira';
          this.isTypingIndicatorVisible = Boolean(isTyping);
          if (isTyping) this.scrollToBottom();
        }
      })
    );

    // 8. Chat Cleared
    this.subs.add(
      this.socketService.chatCleared$.subscribe(() => {
        this.storageService.clearLocalMessages();
        this.clearAllBlobs();
        this.messages = [];
        this.addSystemNote('Your partner cleared the chat history.');
      })
    );

    // 9. Attachment Start (Incoming)
    this.subs.add(
      this.socketService.attachmentStart$.subscribe(meta => {
        const msgRef: DisplayMessage = {
          id: meta.id,
          senderRole: meta.senderRole,
          sentAt: meta.sentAt,
          isAttachment: true,
          attachment: {
            meta,
            progress: 0,
            statusText: 'Receiving & Decrypting…',
            isComplete: false
          }
        };

        this.messages.push(msgRef);
        this.inFlightIncoming.set(meta.id, {
          meta,
          chunks: new Array(meta.totalChunks),
          receivedCount: 0,
          messageRef: msgRef
        });

        this.scrollToBottom();
      })
    );

    // 10. Attachment Chunk (Incoming)
    this.subs.add(
      this.socketService.attachmentChunk$.subscribe(({ id, chunkIndex, totalChunks, data }) => {
        const item = this.inFlightIncoming.get(id);
        if (!item) return;

        item.chunks[chunkIndex] = data;
        item.receivedCount++;

        const pct = Math.round((item.receivedCount / totalChunks) * 100);
        if (item.messageRef.attachment) {
          item.messageRef.attachment.progress = pct;
        }
      })
    );

    // 11. Attachment Complete (Incoming)
    this.subs.add(
      this.socketService.attachmentComplete$.subscribe(async ({ id }) => {
        const item = this.inFlightIncoming.get(id);
        if (!item || !this.encryptionKey) return;

        const { meta, chunks, messageRef } = item;
        if (messageRef.attachment) {
          messageRef.attachment.statusText = 'Decrypting…';
        }

        try {
          let totalByteLength = 0;
          const decodedChunks = chunks.map(c => {
            const bytes = this.cryptoService.base64ToBytes(c);
            totalByteLength += bytes.length;
            return bytes;
          });

          const fullEncryptedBuffer = new Uint8Array(totalByteLength);
          let offset = 0;
          for (const ch of decodedChunks) {
            fullEncryptedBuffer.set(ch, offset);
            offset += ch.length;
          }

          const decrypted = await this.cryptoService.decryptBuffer(
            fullEncryptedBuffer.buffer,
            meta.iv,
            this.encryptionKey
          );

          const blob = new Blob([decrypted], { type: meta.fileType });
          const blobUrl = URL.createObjectURL(blob);

          this.ephemeralBlobs.set(id, { blobUrl, blob, fileName: meta.fileName });
          this.storageService.storeInBrowserCache(id, blob, meta.fileName, meta.fileType);

          if (messageRef.attachment) {
            messageRef.attachment.isComplete = true;
            messageRef.attachment.blobUrl = blobUrl;
            messageRef.attachment.progress = 100;
          }

          // Acknowledge to server so server frees in-memory RAM buffer
          this.socketService.ackAttachment(id);
          this.socketService.markSeen();

          this.inFlightIncoming.delete(id);
          this.scrollToBottom();
        } catch (err) {
          console.error('Failed to decrypt received attachment:', err);
          if (messageRef.attachment) {
            messageRef.attachment.error = 'Decryption error';
          }
          this.inFlightIncoming.delete(id);
        }
      })
    );

    // 12. Attachment Cancelled
    this.subs.add(
      this.socketService.attachmentCancelled$.subscribe(({ id }) => {
        const item = this.inFlightIncoming.get(id);
        if (item && item.messageRef.attachment) {
          item.messageRef.attachment.error = 'Cancelled by partner';
          this.inFlightIncoming.delete(id);
        }
      })
    );
  }

  // -------------------------------------------------------------
  // Manual Ring Partner
  // -------------------------------------------------------------
  async ringPartner(): Promise<void> {
    if (this.isRingingPartner || this.currentStage !== 'chat') return;

    const partnerName = this.myRole === 'he' ? 'Elira' : 'Harry';
    this.isRingingPartner = true;
    this.ringButtonText = '🔔 Ringing…';

    try {
      const res = await this.socketService.ringPartner();
      if (res?.ok) {
        this.addSystemNote(`🔔 Ringing ${partnerName}'s phone...`);
      } else {
        this.addSystemNote(res?.error || 'Could not ring partner.');
      }
    } catch {
      this.addSystemNote('Could not ring partner.');
    } finally {
      setTimeout(() => {
        this.isRingingPartner = false;
        this.ringButtonText = '🔔 Ring';
      }, 3000);
    }
  }

  // -------------------------------------------------------------
  // Clear Chat History & Leave
  // -------------------------------------------------------------
  async clearChat(): Promise<void> {
    if (!confirm('Are you sure you want to permanently delete all chat history?')) return;

    const res = await this.socketService.clearRoom();
    if (res?.ok) {
      this.storageService.clearLocalMessages();
      this.clearAllBlobs();
      this.messages = [];
      this.addSystemNote('Chat history was cleared.');
    }
  }

  leaveRoom(): void {
    location.reload();
  }

  // -------------------------------------------------------------
  // Ephemeral Attachments UI & Handlers
  // -------------------------------------------------------------
  triggerFilePicker(): void {
    if (this.currentStage !== 'chat') return;
    this.fileInput.nativeElement.value = '';
    this.fileInput.nativeElement.click();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      this.handleFileSelection(file);
    }
  }

  handleFileSelection(file: File): void {
    if (file.size > MAX_FILE_SIZE) {
      alert(`⚠️ File is too large (${this.formatBytes(file.size)}). Max allowed is 25 MB.`);
      return;
    }

    this.stagedFile = file;
    this.stagedFileIsImage = file.type.startsWith('image/');
    this.stagedFileName = file.name;
    this.stagedFileMetaText = `${this.formatBytes(file.size)} • ${file.type || 'File'}`;
    this.stagedFileIcon = this.getFileEmoji(file.type, file.name);
    this.attachmentModalError = '';

    if (this.stagedFileIsImage) {
      this.stagedFilePreviewUrl = URL.createObjectURL(file);
    } else {
      this.stagedFilePreviewUrl = null;
    }

    this.showPreviewModal = true;
  }

  closePreviewModal(): void {
    this.showPreviewModal = false;
    if (this.stagedFilePreviewUrl) {
      URL.revokeObjectURL(this.stagedFilePreviewUrl);
      this.stagedFilePreviewUrl = null;
    }
    this.stagedFile = null;
    this.isSendingAttachment = false;
  }

  async sendStagedAttachment(): Promise<void> {
    const file = this.stagedFile;
    if (!file || !this.encryptionKey || !this.myRole) return;

    this.isSendingAttachment = true;

    try {
      const fileBuffer = await file.arrayBuffer();
      const fileSize = file.size;
      const fileName = file.name;
      const fileType = file.type || 'application/octet-stream';
      const isImage = file.type.startsWith('image/');
      const sentAt = Date.now();
      const id = crypto.randomUUID ? crypto.randomUUID() : `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      // 1. Encrypt raw binary file data with AES-256-GCM
      const encrypted = await this.cryptoService.encryptBuffer(fileBuffer, this.encryptionKey);
      const ciphertextBytes = new Uint8Array(encrypted.ciphertext);
      const totalBytes = ciphertextBytes.byteLength;
      const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE);

      // Keep ephemeral blob in memory for sender
      const localBlob = new Blob([fileBuffer], { type: fileType });
      const localBlobUrl = URL.createObjectURL(localBlob);
      this.ephemeralBlobs.set(id, { blobUrl: localBlobUrl, blob: localBlob, fileName });
      this.storageService.storeInBrowserCache(id, localBlob, fileName, fileType);

      this.closePreviewModal();

      const meta: AttachmentMeta = {
        id,
        fileName,
        fileType,
        fileSize,
        totalChunks,
        isImage,
        iv: encrypted.iv,
        senderRole: this.myRole as Role,
        sentAt
      };

      const msgItem: DisplayMessage = {
        id,
        senderRole: this.myRole as Role,
        sentAt,
        isAttachment: true,
        attachment: {
          meta,
          progress: 0,
          statusText: 'Encrypting & Sending…',
          isComplete: false,
          blobUrl: localBlobUrl
        }
      };

      this.messages.push(msgItem);
      this.scrollToBottom();

      // 2. Start Transfer on Socket
      const ack = await this.socketService.startAttachment(meta);
      if (!ack?.ok) {
        if (msgItem.attachment) msgItem.attachment.error = 'Transfer rejected';
        return;
      }

      // 3. Stream Chunks Sequentially
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, totalBytes);
        const chunkSlice = ciphertextBytes.subarray(start, end);

        let binary = '';
        const len = chunkSlice.byteLength;
        for (let b = 0; b < len; b++) {
          binary += String.fromCharCode(chunkSlice[b]);
        }
        const chunkBase64 = btoa(binary);

        this.socketService.sendAttachmentChunk({
          id,
          chunkIndex: i,
          totalChunks,
          data: chunkBase64
        });

        const pct = Math.round(((i + 1) / totalChunks) * 100);
        if (msgItem.attachment) {
          msgItem.attachment.progress = pct;
        }

        if (i % 4 === 0) {
          await new Promise(r => setTimeout(r, 0));
        }
      }

      // 4. Complete Transfer
      await this.socketService.completeAttachment(id);
      if (msgItem.attachment) {
        msgItem.attachment.isComplete = true;
        msgItem.attachment.progress = 100;
      }
      this.scrollToBottom();
    } catch (err: any) {
      console.error('Attachment send error:', err);
      alert('Failed to encrypt and send file: ' + (err.message || err));
      this.isSendingAttachment = false;
    }
  }

  // -------------------------------------------------------------
  // Lightbox & File Saving
  // -------------------------------------------------------------
  openLightbox(blobUrl: string, title: string): void {
    this.lightboxUrl = blobUrl;
    this.lightboxTitle = title;
    this.showLightbox = true;
  }

  closeLightbox(): void {
    this.showLightbox = false;
    this.lightboxUrl = '';
    this.lightboxTitle = '';
  }

  downloadBlob(blobUrl: string, fileName: string): void {
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = fileName || 'attachment';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
    }, 100);
  }

  private clearAllBlobs(): void {
    this.ephemeralBlobs.forEach(item => {
      if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
    });
    this.ephemeralBlobs.clear();
    this.storageService.clearBrowserCache();
  }

  // -------------------------------------------------------------
  // Drag and Drop
  // -------------------------------------------------------------
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    if (this.currentStage === 'chat') {
      this.isDragOver = true;
    }
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver = false;
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver = false;
    if (this.currentStage !== 'chat') return;

    const file = event.dataTransfer?.files?.[0];
    if (file) {
      this.handleFileSelection(file);
    }
  }

  // -------------------------------------------------------------
  // UI Helpers & Formatters
  // -------------------------------------------------------------
  private addSystemNote(text: string): void {
    this.messages.push({
      id: `sys-${Date.now()}-${Math.random()}`,
      sentAt: Date.now(),
      text,
      isSystem: true
    });
    this.scrollToBottom();
  }

  private updatePresenceUI(count: number, partnerOnline: boolean): void {
    this.peopleCount = count;
    this.isPartnerOnline = partnerOnline;
    this.updatePresenceText();
  }

  private updatePresenceText(): void {
    const partnerName = this.myRole === 'he' ? 'Elira' : 'Harry';
    if (this.isPartnerOnline) {
      this.connectionText = `${partnerName} is online`;
    } else if (this.partnerLastSeen) {
      this.connectionText = `${partnerName} last seen ${this.formatLastSeen(this.partnerLastSeen)}`;
    } else {
      this.connectionText = `${partnerName} is offline`;
    }
  }

  private scrollToBottom(): void {
    setTimeout(() => {
      if (this.messagesContainer?.nativeElement) {
        this.messagesContainer.nativeElement.scrollTop = this.messagesContainer.nativeElement.scrollHeight;
      }
    }, 10);
  }

  formatMessageDateTime(input: number): string {
    const date = new Date(input);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = date.toDateString() === yesterday.toDateString();

    const timeStr = this.formatTime12h(date);

    if (isToday) return `Today, ${timeStr}`;
    if (isYesterday) return `Yesterday, ${timeStr}`;

    const isSameYear = date.getFullYear() === now.getFullYear();
    const dateStr = date.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      ...(isSameYear ? {} : { year: 'numeric' })
    });

    return `${dateStr}, ${timeStr}`;
  }

  formatFullDateTime(input: number): string {
    return new Date(input).toLocaleString([], {
      dateStyle: 'full',
      timeStyle: 'medium'
    });
  }

  formatLastSeen(input: number | null): string {
    if (!input) return 'offline';
    const date = new Date(input);
    const now = new Date();
    const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffSec < 60) return 'just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;

    const isToday = date.toDateString() === now.toDateString();
    const timeStr = this.formatTime12h(date);

    if (isToday) return `today at ${timeStr}`;

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return `yesterday at ${timeStr}`;
    }

    const isSameYear = date.getFullYear() === now.getFullYear();
    const dateStr = date.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      ...(isSameYear ? {} : { year: 'numeric' })
    });

    return `${dateStr} at ${timeStr}`;
  }

  private formatTime12h(date: Date): string {
    let hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${hours.toString().padStart(2, '0')}:${minutes} ${ampm}`;
  }

  formatBytes(bytes: number): string {
    if (!bytes || isNaN(bytes)) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  getFileEmoji(type: string, name: string): string {
    const n = (name || '').toLowerCase();
    const t = (type || '').toLowerCase();
    if (t.startsWith('image/')) return '🖼️';
    if (t.includes('pdf') || n.endsWith('.pdf')) return '📕';
    if (t.includes('word') || n.endsWith('.doc') || n.endsWith('.docx')) return '📄';
    if (t.includes('sheet') || t.includes('excel') || n.endsWith('.xls') || n.endsWith('.xlsx')) return '📊';
    if (t.includes('presentation') || n.endsWith('.ppt') || n.endsWith('.pptx')) return '📑';
    if (t.includes('zip') || t.includes('tar') || t.includes('rar') || n.endsWith('.zip') || n.endsWith('.rar') || n.endsWith('.7z')) return '📦';
    if (t.startsWith('audio/') || n.endsWith('.mp3') || n.endsWith('.wav') || n.endsWith('.m4a')) return '🎵';
    if (t.startsWith('video/') || n.endsWith('.mp4') || n.endsWith('.mov') || n.endsWith('.webm')) return '🎥';
    if (t.startsWith('text/') || n.endsWith('.txt')) return '📝';
    return '📎';
  }
}

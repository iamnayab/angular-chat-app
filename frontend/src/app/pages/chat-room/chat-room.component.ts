import {
  Component,
  OnInit,
  OnDestroy,
  ElementRef,
  ViewChild,
  HostListener,
  Input,
  Output,
  EventEmitter
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { MatSnackBar } from '@angular/material/snack-bar';

import {
  Role,
  DisplayMessage,
  EncryptedPayload,
  AttachmentMeta,
  ReplyQuote,
  MessagePayloadData,
  JoinRoomResponse
} from '../../models/chat.models';
import { CryptoService } from '../../services/crypto.service';
import { SocketService } from '../../services/socket.service';
import { StorageService } from '../../services/storage.service';
import { AudioService } from '../../services/audio.service';
import { WebRtcService } from '../../services/webrtc.service';

import { AttachmentModalComponent } from '../../components/attachment-modal/attachment-modal.component';
import { LightboxComponent } from '../../components/lightbox/lightbox.component';

const CHUNK_SIZE = 64 * 1024; // 64 KB chunks for socket streaming
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB max limit

@Component({
  selector: 'app-chat-room',
  standalone: true,
  imports: [CommonModule, FormsModule, AttachmentModalComponent, LightboxComponent],
  templateUrl: './chat-room.component.html',
  styleUrls: ['./chat-room.component.css']
})
export class ChatRoomComponent implements OnInit, OnDestroy {
  @Input({ required: true }) roomId!: string;
  @Input({ required: true }) myRole!: Role;
  @Input({ required: true }) encryptionKey!: CryptoKey;
  @Input() initialData?: JoinRoomResponse;

  @Output() leave = new EventEmitter<void>();

  @ViewChild('messagesContainer') private messagesContainer!: ElementRef<HTMLDivElement>;
  @ViewChild('fileInput') private fileInput!: ElementRef<HTMLInputElement>;
  @ViewChild('messageInputField') private messageInputField!: ElementRef<HTMLInputElement>;

  // Presence & Info
  isPartnerOnline = false;
  partnerLastSeen: number | null = null;
  peopleCount = 1;
  connectionText = 'Connecting…';

  // Unread Tracking & Alerts
  unreadCount = 0;
  firstUnreadMessageId: string | null = null;
  showScrollToBottomPill = false;
  private readonly originalDocumentTitle = 'QuickChat • Encrypted Room';
  private titleBlinkInterval: any = null;

  // Message Selection & Deletion
  isSelectionMode = false;
  selectedMessageIds = new Set<string>();

  // 3-Dot Options Menu & Notification Settings
  isMenuOpen = false;
  isSoundEnabled = true;
  isNotificationsEnabled = true;

  // Chat messages
  messages: DisplayMessage[] = [];
  draftMessage = '';

  // History Pagination (Loads latest 25 messages, loads older on scroll)
  private allSortedHistory: EncryptedPayload[] = [];
  loadedHistoryIndex = 0;
  isLoadingOlderMessages = false;
  hasMoreOlderMessages = false;
  readonly PAGE_SIZE = 25;

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

  // Attachment Staging & Preview Modal
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
    public webrtcService: WebRtcService,
    private snackBar: MatSnackBar
  ) {}

  showWarning(message: string): void {
    this.snackBar.open(message, 'Close', {
      duration: 3000,
      verticalPosition: 'top',
      horizontalPosition: 'center',
      panelClass: ['warning-snackbar']
    });
  }

  ngOnInit(): void {
    // 1. Initialize settings from database (via initialData or fallback query)
    if (this.initialData?.userSettings) {
      this.isSoundEnabled = this.initialData.userSettings.soundEnabled !== false;
      this.isNotificationsEnabled = this.initialData.userSettings.notificationsEnabled !== false;
      this.audioService.setSoundEnabled(this.isSoundEnabled);
      try {
        localStorage.setItem('qc_sound_enabled', this.isSoundEnabled ? 'true' : 'false');
        localStorage.setItem('qc_notifications_enabled', this.isNotificationsEnabled ? 'true' : 'false');
      } catch {}
    } else {
      this.isSoundEnabled = this.audioService.isSoundEnabled();
      try {
        const savedNotif = localStorage.getItem('qc_notifications_enabled');
        this.isNotificationsEnabled = savedNotif !== 'false';
      } catch {
        this.isNotificationsEnabled = true;
      }

      this.socketService.getUserSettings().then((res) => {
        if (res?.ok && res.settings) {
          this.isSoundEnabled = res.settings.soundEnabled !== false;
          this.isNotificationsEnabled = res.settings.notificationsEnabled !== false;
          this.audioService.setSoundEnabled(this.isSoundEnabled);
          try {
            localStorage.setItem('qc_sound_enabled', this.isSoundEnabled ? 'true' : 'false');
            localStorage.setItem('qc_notifications_enabled', this.isNotificationsEnabled ? 'true' : 'false');
          } catch {}
        }
      });
    }

    this.setupSocketSubscriptions();

    if (this.initialData) {
      this.partnerLastSeen = this.initialData.partnerLastSeen ? Number(this.initialData.partnerLastSeen) : null;
      this.updatePresenceUI(this.initialData.count || 1, Boolean(this.initialData.partnerOnline));
      this.loadAndDecryptHistory(this.initialData.history || []);
    }

    // Mark unread partner messages as seen
    this.socketService.markSeen();

    setTimeout(() => {
      this.messageInputField?.nativeElement?.focus();
      this.scrollToBottom();
    }, 100);

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    this.relativeTimeInterval = setInterval(() => {
      if (!this.isPartnerOnline && this.partnerLastSeen) {
        this.updatePresenceText();
      }
    }, 30000);
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.stopTitleAlert();
    if (this.relativeTimeInterval) clearInterval(this.relativeTimeInterval);
    this.clearAllBlobs();
  }

  @HostListener('window:focus')
  onWindowFocus(): void {
    this.stopTitleAlert();
    this.socketService.markSeen();
  }

  @HostListener('document:visibilitychange')
  onVisibilityChange(): void {
    if (!document.hidden) {
      this.stopTitleAlert();
      this.socketService.markSeen();
    }
  }

  // -------------------------------------------------------------
  // Keyboard & Clipboard Listeners
  // -------------------------------------------------------------
  @HostListener('document:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (this.isMenuOpen) this.closeMenu();
      if (this.showLightbox) this.closeLightbox();
      if (this.showPreviewModal) this.closePreviewModal();
      if (this.editingMessage) this.cancelEdit();
      if (this.replyingTo) this.cancelReply();
    }
  }

  @HostListener('document:click', ['$event'])
  @HostListener('document:touchstart', ['$event'])
  handleOutsideInteraction(event: Event): void {
    if (!this.isMenuOpen) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    // If the tap or click was inside the dropdown menu or on the 3-dot button, don't close here
    if (target.closest('.chat-menu-dropdown') || target.closest('.menu-action-btn')) {
      return;
    }
    this.closeMenu();
  }

  @HostListener('document:paste', ['$event'])
  handlePasteEvent(event: ClipboardEvent): void {
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
  // Chat History Decryption & Synchronization with 25-Message Pagination
  // -------------------------------------------------------------
  private async decryptSingleMessage(msg: EncryptedPayload): Promise<DisplayMessage | null> {
    try {
      if (msg.isAttachment) {
        const att = msg.attachment;
        const attData = att?.data || (msg as any).data || '';
        const caption = (msg as any).caption || att?.meta?.caption || msg.ciphertext || '';
        const meta: AttachmentMeta = att?.meta || {
          id: msg.id,
          fileName: 'image.jpg',
          fileType: 'image/jpeg',
          fileSize: 0,
          totalChunks: 1,
          isImage: true,
          iv: '',
          senderRole: msg.senderRole || this.myRole,
          sentAt: Number(msg.sentAt) || Date.now(),
          caption: caption || undefined
        };

        // If attachment data is already a Data URL (clean unencrypted image)
        let blobUrl = attData;

        // If it was encrypted with IV and not a Data URL, attempt decrypt fallback
        if (attData && meta.iv && !attData.startsWith('data:')) {
          try {
            const bytes = this.cryptoService.base64ToBytes(attData);
            const decrypted = await this.cryptoService.decryptBuffer(
              bytes.buffer,
              meta.iv,
              this.encryptionKey!
            );
            const blob = new Blob([decrypted], { type: meta.fileType });
            blobUrl = URL.createObjectURL(blob);
          } catch (e) {
            console.warn('Fallback decryption notice:', e);
          }
        }

        return {
          id: msg.id,
          senderRole: msg.senderRole,
          sentAt: Number(msg.sentAt) || Date.now(),
          seen: msg.seen,
          text: caption || undefined,
          isAttachment: true,
          attachment: {
            meta,
            progress: 100,
            statusText: 'Saved in Supabase',
            isComplete: true,
            blobUrl: blobUrl || ''
          }
        } as DisplayMessage;
      }

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
  }

  private async loadAndDecryptHistory(serverMsgs: EncryptedPayload[]): Promise<void> {
    if (!this.encryptionKey) return;

    const localMsgs = this.storageService.getLocalMessages();
    const combined: EncryptedPayload[] = [...localMsgs];

    for (const sm of serverMsgs) {
      const existing = combined.find(
        m => (m.id && sm.id && m.id === sm.id) ||
             (m.ciphertext && sm.ciphertext && m.ciphertext.trim() !== '' && m.ciphertext === sm.ciphertext)
      );
      if (existing) {
        existing.seen = Boolean(existing.seen || sm.seen);
        existing.sentAt = Number(sm.sentAt) || Number(existing.sentAt) || Date.now();
        existing.id = sm.id || existing.id;
        existing.editedAt = sm.editedAt ? Number(sm.editedAt) : existing.editedAt;
        if (sm.attachment) existing.attachment = sm.attachment;
        if (sm.isAttachment) existing.isAttachment = true;
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
    this.allSortedHistory = combined;

    // Load only the latest 25 messages on initial join for blazing-fast opening
    let initialBatch: EncryptedPayload[] = [];
    if (combined.length > this.PAGE_SIZE) {
      this.loadedHistoryIndex = combined.length - this.PAGE_SIZE;
      initialBatch = combined.slice(this.loadedHistoryIndex);
      this.hasMoreOlderMessages = true;
    } else {
      this.loadedHistoryIndex = 0;
      initialBatch = combined;
      this.hasMoreOlderMessages = false;
    }

    const decryptedList = await Promise.all(
      initialBatch.map(msg => this.decryptSingleMessage(msg))
    );

    this.messages = decryptedList.filter(m => m !== null) as DisplayMessage[];

    // Track unread messages on opening chat
    const unreadMsgs = this.messages.filter(m => m.senderRole !== this.myRole && !m.seen);
    if (unreadMsgs.length > 0) {
      this.firstUnreadMessageId = unreadMsgs[0].id;
      this.unreadCount = unreadMsgs.length;
    }

    setTimeout(() => this.scrollToBottom(true), 60);
  }

  async loadOlderMessages(): Promise<void> {
    if (this.isLoadingOlderMessages || !this.hasMoreOlderMessages || this.loadedHistoryIndex <= 0) {
      return;
    }

    this.isLoadingOlderMessages = true;
    const container = this.messagesContainer?.nativeElement;
    const prevScrollHeight = container ? container.scrollHeight : 0;
    const prevScrollTop = container ? container.scrollTop : 0;

    const nextIndex = Math.max(0, this.loadedHistoryIndex - this.PAGE_SIZE);
    const olderBatch = this.allSortedHistory.slice(nextIndex, this.loadedHistoryIndex);
    this.loadedHistoryIndex = nextIndex;
    this.hasMoreOlderMessages = this.loadedHistoryIndex > 0;

    const decryptedList = await Promise.all(
      olderBatch.map(msg => this.decryptSingleMessage(msg))
    );
    const validOlder = decryptedList.filter(m => m !== null) as DisplayMessage[];

    this.messages = [...validOlder, ...this.messages];

    setTimeout(() => {
      if (container) {
        const newScrollHeight = container.scrollHeight;
        container.scrollTop = newScrollHeight - prevScrollHeight + prevScrollTop;
      }
      this.isLoadingOlderMessages = false;
    }, 60);
  }

  onMessagesScroll(event: Event): void {
    const el = event.target as HTMLElement;
    if (!el) return;

    if (el.scrollTop <= 80 && this.hasMoreOlderMessages && !this.isLoadingOlderMessages) {
      this.loadOlderMessages();
    }

    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (isNearBottom) {
      this.showScrollToBottomPill = false;
      if (document.hasFocus()) {
        this.socketService.markSeen();
      }
    }
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
    this.firstUnreadMessageId = null;
    this.unreadCount = 0;

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
        roomId: this.roomId || '0202',
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        senderRole: this.myRole,
        sentAt,
        seen: false
      };

      // Push locally immediately
      this.messages.push({
        id,
        senderRole: this.myRole,
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
    if (!msg || !this.myRole) return;

    if (!msg.isAttachment && !newText) return;

    const editedAt = Date.now();

    try {
      if (msg.isAttachment) {
        // Caption update for photo attachment
        msg.text = newText || undefined;
        if (msg.attachment?.meta) {
          msg.attachment.meta.caption = newText || undefined;
        }
        msg.isEdited = true;
        msg.editedAt = editedAt;

        // Update local storage
        const localList = this.storageService.getLocalMessages();
        const localMsg = localList.find(m => m.id === msg.id);
        if (localMsg) {
          localMsg.ciphertext = newText;
          localMsg.editedAt = editedAt;
          if (localMsg.attachment?.meta) {
            localMsg.attachment.meta.caption = newText;
          }
          this.storageService.saveLocalMessage(localMsg);
        }

        // Reset edit state
        this.editingMessage = null;
        this.draftMessage = '';

        // Emit edit to server
        const payload: EncryptedPayload = {
          id: msg.id,
          roomId: this.roomId || '0202',
          iv: '',
          ciphertext: newText,
          senderRole: this.myRole,
          sentAt: msg.sentAt,
          editedAt,
          isAttachment: true
        };
        await this.socketService.editChatMessage(payload);
        return;
      }

      // Regular text message
      if (!this.encryptionKey) return;
      const payloadData: MessagePayloadData = {
        text: newText,
        replyTo: msg.replyTo
      };

      const encrypted = await this.cryptoService.encryptMessage(payloadData, this.encryptionKey);

      const editedPayload: EncryptedPayload = {
        id: msg.id,
        roomId: this.roomId || '0202',
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        senderRole: this.myRole,
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
    if (msg.senderRole !== this.myRole || msg.isSystem) return;
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
    } else if (snippet.length > 80) {
      snippet = snippet.slice(0, 80) + '…';
    }

    this.replyingTo = {
      id: msg.id,
      senderRole: msg.senderRole || this.myRole,
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
  // Calling Action
  // -------------------------------------------------------------
  startCall(type: 'audio' | 'video'): void {
    if (!this.isPartnerOnline) {
      const partner = this.myRole === 'he' ? 'Elira' : 'Harry';
      this.showWarning(`${partner} is offline right now. Cannot start call.`);
      return;
    }
    const partnerRole = this.myRole === 'he' ? 'she' : 'he';
    this.webrtcService.startCall(partnerRole, type === 'video');
  }

  // -------------------------------------------------------------
  // Socket Subscriptions
  // -------------------------------------------------------------
  private setupSocketSubscriptions(): void {
    // 1. Reconnect
    this.subs.add(
      this.socketService.connect$.subscribe(() => {
        if (this.encryptionKey && this.myRole && this.roomId) {
          this.socketService.joinRoom(this.roomId, this.myRole).then(() => {
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

          // Sound chime
          this.audioService.playMessageChime();

          // Unread tracking & Notifications
          this.handleIncomingNotification(payload.senderRole, decrypted.text, payload.id);
        } catch (err) {
          console.warn('Failed to decrypt incoming message:', err);
        }
      })
    );

    // 2b. Incoming Direct Image Message (Instant WhatsApp Style)
    this.subs.add(
      this.socketService.chatImage$.subscribe((payload) => {
        if (!payload || !payload.id) return;
        if (this.messages.some(m => m.id === payload.id)) return;

        const sentAt = Number(payload.sentAt) || Date.now();
        const caption = typeof payload.caption === 'string' ? payload.caption.trim() : '';

        this.messages.push({
          id: payload.id,
          senderRole: payload.senderRole,
          sentAt,
          text: caption || undefined,
          isAttachment: true,
          seen: false,
          attachment: {
            meta: {
              id: payload.id,
              fileName: payload.fileName || 'image.jpg',
              fileType: payload.fileType || 'image/jpeg',
              fileSize: payload.fileSize || 0,
              totalChunks: 1,
              isImage: true,
              iv: '',
              senderRole: payload.senderRole,
              sentAt,
              caption
            },
            progress: 100,
            statusText: 'Received',
            isComplete: true,
            blobUrl: payload.data
          }
        });

        // Also save into local cache for instant reload
        this.storageService.saveLocalMessage({
          id: payload.id,
          roomId: payload.roomId || this.roomId,
          iv: '',
          ciphertext: caption,
          senderRole: payload.senderRole,
          sentAt,
          seen: false,
          isAttachment: true,
          attachment: {
            meta: {
              id: payload.id,
              fileName: payload.fileName || 'image.jpg',
              fileType: payload.fileType || 'image/jpeg',
              fileSize: payload.fileSize || 0,
              totalChunks: 1,
              isImage: true,
              iv: '',
              senderRole: payload.senderRole,
              sentAt,
              caption
            },
            data: payload.data
          }
        });

        this.isTypingIndicatorVisible = false;

        // Sound chime
        this.audioService.playMessageChime();

        // Unread tracking & Notifications
        this.handleIncomingNotification(payload.senderRole, caption || 'Photo', payload.id);
      })
    );

    // 3. Message Edited by Partner
    this.subs.add(
      this.socketService.messageEdited$.subscribe(async payload => {
        const existing = this.messages.find(m => m.id === payload.id);
        if (existing) {
          try {
            if (existing.isAttachment) {
              // Partner edited photo caption
              let newCaption = payload.ciphertext || '';
              if (payload.iv && this.encryptionKey) {
                try {
                  const decrypted = await this.cryptoService.decryptMessage(payload, this.encryptionKey);
                  newCaption = decrypted.text;
                } catch {
                  newCaption = payload.ciphertext || '';
                }
              }
              const trimmed = newCaption.trim();
              existing.text = trimmed ? trimmed : undefined;
              if (existing.attachment?.meta) {
                existing.attachment.meta.caption = existing.text;
              }
              existing.isEdited = true;
              existing.editedAt = Number(payload.editedAt) || Date.now();

              // Update in local cache
              const localMsg = this.storageService.getLocalMessages().find(m => m.id === payload.id);
              if (localMsg) {
                localMsg.ciphertext = trimmed;
                localMsg.editedAt = existing.editedAt;
                if (localMsg.attachment?.meta) {
                  localMsg.attachment.meta.caption = trimmed;
                }
                this.storageService.saveLocalMessage(localMsg);
              }
            } else {
              if (!this.encryptionKey) return;
              const decrypted = await this.cryptoService.decryptMessage(payload, this.encryptionKey);
              existing.text = decrypted.text;
              if (decrypted.replyTo) existing.replyTo = decrypted.replyTo;
              existing.isEdited = true;
              existing.editedAt = Number(payload.editedAt) || Date.now();
              this.storageService.saveLocalMessage(payload);
            }
          } catch (err) {
            console.warn('Failed to handle edited message:', err);
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

    // 6. Typing Indicator
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
        this.allSortedHistory = [];
        this.loadedHistoryIndex = 0;
        this.hasMoreOlderMessages = false;
        this.isLoadingOlderMessages = false;
        this.firstUnreadMessageId = null;
        this.unreadCount = 0;
        this.cancelSelection();
        this.addSystemNote('Your partner cleared the chat history.');
      })
    );

    // 8b. Messages Deleted
    this.subs.add(
      this.socketService.messagesDeleted$.subscribe(({ messageIds }) => {
        this.handleMessagesDeleted(messageIds);
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

          // Notification sound & alert
          this.audioService.playMessageChime();
          this.handleIncomingNotification(meta.senderRole, meta.fileName || 'Attachment', id);

          this.inFlightIncoming.delete(id);
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
  // Clear Chat History & Leave
  // -------------------------------------------------------------
  clearChat(): void {
    const snackRef = this.snackBar.open(
      '⚠️ Permanently delete all chat history in this room?',
      'CLEAR ALL',
      {
        duration: 6000,
        verticalPosition: 'top',
        horizontalPosition: 'center',
        panelClass: ['warning-snackbar', 'danger-snackbar']
      }
    );

    snackRef.onAction().subscribe(async () => {
      const res = await this.socketService.clearRoom();
      if (res?.ok) {
        this.storageService.clearLocalMessages();
        this.clearAllBlobs();
        this.messages = [];
        this.allSortedHistory = [];
        this.loadedHistoryIndex = 0;
        this.hasMoreOlderMessages = false;
        this.isLoadingOlderMessages = false;
        this.firstUnreadMessageId = null;
        this.unreadCount = 0;
        this.cancelSelection();
        this.addSystemNote('Chat history was cleared.');
        this.showWarning('Chat history has been cleared permanently.');
      }
    });
  }

  // -------------------------------------------------------------
  // Unread Tracking & Title Alert Helpers
  // -------------------------------------------------------------
  private handleIncomingNotification(senderRole: Role, text?: string, messageId?: string): void {
    const senderName = senderRole === 'he' ? 'Harry' : 'Elira';
    const isDocHidden = document.hidden || !document.hasFocus();
    const container = this.messagesContainer?.nativeElement;
    const isScrolledUp = container ? (container.scrollHeight - container.scrollTop - container.clientHeight > 150) : false;

    if (isDocHidden || isScrolledUp) {
      this.unreadCount++;
      if (!this.firstUnreadMessageId && messageId) {
        this.firstUnreadMessageId = messageId;
      }
      if (isScrolledUp) {
        this.showScrollToBottomPill = true;
      }
      if (isDocHidden && this.isNotificationsEnabled) {
        this.startTitleAlert(senderName);
        if ('Notification' in window && Notification.permission === 'granted') {
          try {
            new Notification(`New message from ${senderName}`, {
              body: text || 'New encrypted message',
              icon: '/favicon.ico'
            });
          } catch {}
        }
      }
    } else {
      this.scrollToBottom();
      this.socketService.markSeen();
    }
  }

  private startTitleAlert(senderName: string): void {
    if (this.titleBlinkInterval) clearInterval(this.titleBlinkInterval);
    let toggle = false;
    this.titleBlinkInterval = setInterval(() => {
      document.title = toggle ? `💬 (${this.unreadCount}) New message!` : `QuickChat • ${senderName}`;
      toggle = !toggle;
    }, 1200);
  }

  private stopTitleAlert(): void {
    if (this.titleBlinkInterval) {
      clearInterval(this.titleBlinkInterval);
      this.titleBlinkInterval = null;
    }
    document.title = this.originalDocumentTitle;
  }

  // -------------------------------------------------------------
  // Message Selection & Deletion Handlers
  // -------------------------------------------------------------
  toggleSelectionMode(): void {
    this.isSelectionMode = !this.isSelectionMode;
    if (!this.isSelectionMode) {
      this.selectedMessageIds.clear();
    }
  }

  toggleMessageSelection(msgId: string, event?: Event): void {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (this.selectedMessageIds.has(msgId)) {
      this.selectedMessageIds.delete(msgId);
      if (this.selectedMessageIds.size === 0) {
        this.isSelectionMode = false;
      }
    } else {
      this.selectedMessageIds.add(msgId);
      this.isSelectionMode = true;
    }
  }

  isMessageSelected(msgId: string): boolean {
    return this.selectedMessageIds.has(msgId);
  }

  selectAllMessages(): void {
    this.isSelectionMode = true;
    this.messages.forEach(m => {
      if (!m.isSystem) {
        this.selectedMessageIds.add(m.id);
      }
    });
  }

  cancelSelection(): void {
    this.isSelectionMode = false;
    this.selectedMessageIds.clear();
  }

  confirmDeleteSingleMessage(msg: DisplayMessage, event?: Event): void {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const snackRef = this.snackBar.open(
      'Delete this message?',
      'DELETE',
      {
        duration: 4000,
        verticalPosition: 'top',
        horizontalPosition: 'center',
        panelClass: ['warning-snackbar', 'danger-snackbar']
      }
    );

    snackRef.onAction().subscribe(async () => {
      await this.executeDeleteMessages([msg.id]);
    });
  }

  deleteSelectedMessages(): void {
    if (this.selectedMessageIds.size === 0) return;
    const ids = Array.from(this.selectedMessageIds);
    const count = ids.length;

    const snackRef = this.snackBar.open(
      `Delete ${count} selected message${count > 1 ? 's' : ''}?`,
      'DELETE ALL',
      {
        duration: 5000,
        verticalPosition: 'top',
        horizontalPosition: 'center',
        panelClass: ['warning-snackbar', 'danger-snackbar']
      }
    );

    snackRef.onAction().subscribe(async () => {
      await this.executeDeleteMessages(ids);
    });
  }

  async executeDeleteMessages(ids: string[]): Promise<void> {
    const res = await this.socketService.deleteMessages(ids);
    if (res?.ok) {
      this.handleMessagesDeleted(ids);
      this.showWarning(`${ids.length} message${ids.length > 1 ? 's' : ''} deleted.`);
    } else {
      this.showWarning('Could not delete messages.');
    }
  }

  private handleMessagesDeleted(ids: string[]): void {
    const idSet = new Set(ids);
    this.messages = this.messages.filter(m => !idSet.has(m.id));
    this.allSortedHistory = this.allSortedHistory.filter(m => !idSet.has(m.id));
    this.storageService.deleteLocalMessages(ids);

    ids.forEach(id => {
      const ep = this.ephemeralBlobs.get(id);
      if (ep) {
        URL.revokeObjectURL(ep.blobUrl);
        this.ephemeralBlobs.delete(id);
      }
      this.selectedMessageIds.delete(id);
    });

    if (this.selectedMessageIds.size === 0) {
      this.isSelectionMode = false;
    }
  }

  leaveRoom(): void {
    this.leave.emit();
  }

  // -------------------------------------------------------------
  // 3-Dot Options Menu & Notification Toggles
  // -------------------------------------------------------------
  toggleMenu(event?: Event): void {
    if (event) event.stopPropagation();
    this.isMenuOpen = !this.isMenuOpen;
  }

  closeMenu(): void {
    this.isMenuOpen = false;
  }

  onMenuSelectMessages(): void {
    this.closeMenu();
    this.toggleSelectionMode();
  }

  onMenuToggleSound(): void {
    this.isSoundEnabled = this.audioService.toggleSound();
    try {
      localStorage.setItem('qc_sound_enabled', this.isSoundEnabled ? 'true' : 'false');
    } catch {}

    // Persist permanently in database
    this.socketService.updateUserSettings({ soundEnabled: this.isSoundEnabled });

    this.snackBar.open(
      this.isSoundEnabled ? '🔔 Notification sound turned ON (Saved in DB)' : '🔕 Notification sound MUTED (Saved in DB)',
      'OK',
      { duration: 2500, verticalPosition: 'top', horizontalPosition: 'center' }
    );
  }

  async onMenuToggleNotifications(): Promise<void> {
    if (!this.isNotificationsEnabled) {
      if ('Notification' in window) {
        if (Notification.permission === 'default') {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') {
            this.snackBar.open('⚠️ Browser notification permission denied', 'OK', {
              duration: 3000,
              verticalPosition: 'top',
              horizontalPosition: 'center'
            });
            return;
          }
        } else if (Notification.permission === 'denied') {
          this.snackBar.open('⚠️ Notifications blocked in browser settings', 'OK', {
            duration: 3000,
            verticalPosition: 'top',
            horizontalPosition: 'center'
          });
          return;
        }
      }
      this.isNotificationsEnabled = true;
      try {
        localStorage.setItem('qc_notifications_enabled', 'true');
      } catch {}

      // Persist permanently in database
      this.socketService.updateUserSettings({ notificationsEnabled: true });

      this.snackBar.open('💬 Notifications turned ON (Saved in DB)', 'OK', {
        duration: 2500,
        verticalPosition: 'top',
        horizontalPosition: 'center'
      });
    } else {
      this.isNotificationsEnabled = false;
      try {
        localStorage.setItem('qc_notifications_enabled', 'false');
      } catch {}
      this.stopTitleAlert();

      // Persist permanently in database
      this.socketService.updateUserSettings({ notificationsEnabled: false });

      this.snackBar.open('🔕 Notifications MUTED (Saved in DB)', 'OK', {
        duration: 2500,
        verticalPosition: 'top',
        horizontalPosition: 'center'
      });
    }
  }

  onMenuClearChat(): void {
    this.closeMenu();
    this.clearChat();
  }

  onMenuLeaveRoom(): void {
    this.closeMenu();
    this.leaveRoom();
  }

  // -------------------------------------------------------------
  // Ephemeral Attachments UI & Handlers
  // -------------------------------------------------------------
  triggerFilePicker(): void {
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
      this.showWarning(`⚠️ File is too large (${this.formatBytes(file.size)}). Max allowed is 25 MB.`);
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

  async sendStagedAttachment(caption: string = ''): Promise<void> {
    const file = this.stagedFile;
    if (!file || !this.myRole) return;

    const trimmedCaption = (caption || '').trim();
    this.isSendingAttachment = true;

    try {
      const fileSize = file.size;
      const fileName = file.name;
      const fileType = file.type || 'application/octet-stream';
      const isImage = this.stagedFileIsImage || file.type.startsWith('image/');
      const sentAt = Date.now();
      const id = crypto.randomUUID ? crypto.randomUUID() : `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      // Direct WhatsApp-Style Image Sending (Saved permanently in Supabase, renders directly in chat with caption)
      if (isImage) {
        const dataUrl = await this.readImageAsDataUrl(file);
        this.closePreviewModal();

        const msgItem: DisplayMessage = {
          id,
          senderRole: this.myRole,
          sentAt,
          text: trimmedCaption || undefined,
          isAttachment: true,
          attachment: {
            meta: {
              id,
              fileName,
              fileType,
              fileSize,
              totalChunks: 1,
              isImage: true,
              iv: '',
              senderRole: this.myRole,
              sentAt,
              caption: trimmedCaption
            },
            progress: 100,
            statusText: 'Sent',
            isComplete: true,
            blobUrl: dataUrl
          }
        };

        this.messages.push(msgItem);
        this.scrollToBottom();

        // Save locally for instant reload
        this.storageService.saveLocalMessage({
          id,
          roomId: this.roomId,
          iv: '',
          ciphertext: trimmedCaption,
          senderRole: this.myRole,
          sentAt,
          seen: false,
          isAttachment: true,
          attachment: {
            meta: msgItem.attachment!.meta,
            data: dataUrl
          }
        });

        await this.socketService.sendImageMessage({
          id,
          roomId: this.roomId,
          fileName,
          fileType,
          fileSize,
          senderRole: this.myRole,
          sentAt,
          data: dataUrl,
          caption: trimmedCaption
        });

        this.isSendingAttachment = false;
        return;
      }

      if (!this.encryptionKey) return;
      const fileBuffer = await file.arrayBuffer();

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
        senderRole: this.myRole,
        sentAt
      };

      const msgItem: DisplayMessage = {
        id,
        senderRole: this.myRole,
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
      this.showWarning('Failed to encrypt and send file: ' + (err.message || err));
    } finally {
      this.isSendingAttachment = false;
    }
  }

  private readImageAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const rawResult = reader.result as string;
        const img = new Image();
        img.onload = () => {
          const maxDim = 1280;
          let width = img.width;
          let height = img.height;
          if (width > maxDim || height > maxDim) {
            if (width > height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL(file.type || 'image/jpeg', 0.85));
          } else {
            resolve(rawResult);
          }
        };
        img.onerror = () => resolve(rawResult);
        img.src = rawResult;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
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
    this.isDragOver = true;
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver = false;
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver = false;

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
  if (this.isPartnerOnline) {
    this.connectionText = 'Online';
  } else if (this.partnerLastSeen) {
    this.connectionText = `Last seen ${this.formatLastSeen(this.partnerLastSeen)}`;
  } else {
    this.connectionText = 'Offline';
  }
}

  public scrollToBottom(instant = false): void {
    this.showScrollToBottomPill = false;
    setTimeout(() => {
      if (this.messagesContainer?.nativeElement) {
        if (instant) {
          this.messagesContainer.nativeElement.scrollTop = this.messagesContainer.nativeElement.scrollHeight;
        } else {
          try {
            this.messagesContainer.nativeElement.scrollTo({
              top: this.messagesContainer.nativeElement.scrollHeight,
              behavior: 'smooth'
            });
          } catch {
            this.messagesContainer.nativeElement.scrollTop = this.messagesContainer.nativeElement.scrollHeight;
          }
        }
      }
    }, 20);
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

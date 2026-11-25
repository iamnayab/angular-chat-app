import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Subject } from 'rxjs';
import { EncryptedPayload, JoinRoomResponse, Role, AttachmentMeta } from '../models/chat.models';

@Injectable({
  providedIn: 'root'
})
export class SocketService {
  private socket!: Socket;

  public connect$ = new Subject<void>();
  public disconnect$ = new Subject<void>();
  public chatMessage$ = new Subject<EncryptedPayload>();
  public chatImage$ = new Subject<any>();
  public messageEdited$ = new Subject<EncryptedPayload>();
  public messagesSeen$ = new Subject<{ seenBy: Role; at: number }>();
  public userStatus$ = new Subject<{ role: Role; isOnline: boolean; lastSeen?: number }>();
  public roomCount$ = new Subject<number>();
  public typing$ = new Subject<{ role: Role; isTyping: boolean }>();
  public chatCleared$ = new Subject<void>();
  public messagesDeleted$ = new Subject<{ messageIds: string[] }>();

  // Attachment Observables
  public attachmentStart$ = new Subject<AttachmentMeta>();
  public attachmentChunk$ = new Subject<{ id: string; chunkIndex: number; totalChunks: number; data: string }>();
  public attachmentComplete$ = new Subject<{ id: string; senderRole: Role }>();
  public attachmentCancelled$ = new Subject<{ id: string }>();

  // WebRTC Calling Observables
  public incomingCall$ = new Subject<{
    fromRole: Role;
    fromName: string;
    offer: any;
    isVideo: boolean;
    callId: string;
  }>();
  public callAnswered$ = new Subject<{ fromRole: Role; answer: any; callId: string }>();
  public iceCandidate$ = new Subject<{ fromRole: Role; candidate: any }>();
  public callEnded$ = new Subject<{ fromRole: Role; reason: string }>();
  public callRejected$ = new Subject<{ fromRole: Role }>();
  public callFailed$ = new Subject<{ reason: string }>();

  constructor() {
    this.initSocket();
  }

  private initSocket(): void {
    const serverUrl = window.location.port === '4200' ? 'http://localhost:3000' : '/';
    this.socket = io(serverUrl, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000
    });

    this.socket.on('connect', () => this.connect$.next());
    this.socket.on('disconnect', () => this.disconnect$.next());

    this.socket.on('chat-message', (data: EncryptedPayload) => this.chatMessage$.next(data));
    this.socket.on('chat-image', (data: any) => this.chatImage$.next(data));
    this.socket.on('message-edited', (data: EncryptedPayload) => this.messageEdited$.next(data));
    this.socket.on('messages-seen', (data: { seenBy: Role; at: number }) => this.messagesSeen$.next(data));
    this.socket.on('user-status', (data: { role: Role; isOnline: boolean; lastSeen?: number }) => this.userStatus$.next(data));
    this.socket.on('room-count', (count: number) => this.roomCount$.next(count));
    this.socket.on('typing', (data: { role: Role; isTyping: boolean }) => this.typing$.next(data));
    this.socket.on('chat-cleared', () => this.chatCleared$.next());
    this.socket.on('messages-deleted', (data: { messageIds: string[] }) => this.messagesDeleted$.next(data));

    // Attachment listeners
    this.socket.on('attachment:start', (meta: AttachmentMeta) => this.attachmentStart$.next(meta));
    this.socket.on('attachment:chunk', (data: { id: string; chunkIndex: number; totalChunks: number; data: string }) => this.attachmentChunk$.next(data));
    this.socket.on('attachment:complete', (data: { id: string; senderRole: Role }) => this.attachmentComplete$.next(data));
    this.socket.on('attachment:cancelled', (data: { id: string }) => this.attachmentCancelled$.next(data));

    // WebRTC Calling listeners
    this.socket.on('webrtc:incoming-call', (data: any) => this.incomingCall$.next(data));
    this.socket.on('webrtc:call-answered', (data: any) => this.callAnswered$.next(data));
    this.socket.on('webrtc:ice-candidate', (data: any) => this.iceCandidate$.next(data));
    this.socket.on('webrtc:call-ended', (data: any) => this.callEnded$.next(data));
    this.socket.on('webrtc:call-rejected', (data: any) => this.callRejected$.next(data));
    this.socket.on('webrtc:call-failed', (data: any) => this.callFailed$.next(data));
  }

  get isConnected(): boolean {
    return Boolean(this.socket && this.socket.connected);
  }

  joinRoom(roomId: string, role: Role): Promise<JoinRoomResponse> {
    return new Promise((resolve) => {
      this.socket.emit('join-room', { roomId, role }, (res: JoinRoomResponse) => {
        resolve(res);
      });
    });
  }

  sendChatMessage(msg: EncryptedPayload): Promise<{ ok: boolean; id?: string; sentAt?: number; error?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('chat-message', msg, (res: { ok: boolean; id?: string; sentAt?: number; error?: string }) => {
        resolve(res || { ok: false });
      });
    });
  }

  sendImageMessage(payload: any): Promise<{ ok: boolean; id?: string; sentAt?: number; error?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('chat-image', payload, (res: { ok: boolean; id?: string; sentAt?: number; error?: string }) => {
        resolve(res || { ok: false });
      });
    });
  }

  editChatMessage(msg: EncryptedPayload): Promise<{ ok: boolean; id?: string; editedAt?: number; error?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('edit-message', msg, (res: { ok: boolean; id?: string; editedAt?: number; error?: string }) => {
        resolve(res || { ok: false });
      });
    });
  }

  sendTyping(isTyping: boolean): void {
    this.socket.emit('typing', { isTyping });
  }

  markSeen(): void {
    this.socket.emit('mark-seen');
  }

  clearRoom(): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('clear-room', (res: { ok: boolean; error?: string }) => {
        resolve(res || { ok: false });
      });
    });
  }

  deleteMessages(messageIds: string[]): Promise<{ ok: boolean; deletedCount?: number; error?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('delete-messages', { messageIds }, (res: { ok: boolean; deletedCount?: number; error?: string }) => {
        resolve(res || { ok: false });
      });
    });
  }

  // Ephemeral Attachment Relays
  startAttachment(meta: AttachmentMeta): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      this.socket.emit('attachment:start', meta, (res: { ok: boolean; error?: string }) => {
        resolve(res || { ok: false });
      });
    });
  }

  sendAttachmentChunk(payload: { id: string; chunkIndex: number; totalChunks: number; data: string }): void {
    this.socket.emit('attachment:chunk', payload);
  }

  completeAttachment(id: string): Promise<{ ok: boolean }> {
    return new Promise((resolve) => {
      this.socket.emit('attachment:complete', { id }, (res: { ok: boolean }) => {
        resolve(res || { ok: false });
      });
    });
  }

  ackAttachment(id: string): void {
    this.socket.emit('attachment:ack', { id });
  }

  cancelAttachment(id: string): void {
    this.socket.emit('attachment:cancel', { id });
  }

  // WebRTC Calling Emitters
  callUser(payload: { toRole?: Role; offer: any; isVideo: boolean; callId: string }): void {
    this.socket.emit('webrtc:call-user', payload);
  }

  answerCall(payload: { toRole?: Role; answer: any; callId: string }): void {
    this.socket.emit('webrtc:answer-call', payload);
  }

  sendIceCandidate(payload: { toRole?: Role; candidate: any }): void {
    this.socket.emit('webrtc:ice-candidate', payload);
  }

  endCall(payload: { toRole?: Role; reason?: string }): void {
    this.socket.emit('webrtc:end-call', payload);
  }

  rejectCall(payload: { toRole?: Role }): void {
    this.socket.emit('webrtc:reject-call', payload);
  }
}

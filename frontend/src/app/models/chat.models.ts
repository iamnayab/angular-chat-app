export type Role = 'he' | 'she';

export interface AttachmentMeta {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  totalChunks: number;
  isImage: boolean;
  iv: string;
  senderRole: Role;
  sentAt: number;
  caption?: string;
}

export interface AttachmentState {
  meta: AttachmentMeta;
  progress: number;
  statusText: string;
  isComplete: boolean;
  blobUrl?: string;
  error?: string;
}

export interface EncryptedPayload {
  id: string;
  roomId: string;
  iv: string;
  ciphertext: string;
  senderRole: Role;
  sentAt: number;
  seen?: boolean;
  editedAt?: number;
  isAttachment?: boolean;
  attachment?: {
    meta: AttachmentMeta;
    data?: string;
  };
}

export interface ReplyQuote {
  id: string;
  senderRole: Role;
  text: string;
}

export interface MessagePayloadData {
  text: string;
  replyTo?: ReplyQuote;
}

export interface DisplayMessage {
  id: string;
  senderRole?: Role;
  sentAt: number;
  text?: string;
  seen?: boolean;
  isSystem?: boolean;
  isAttachment?: boolean;
  attachment?: AttachmentState;
  replyTo?: ReplyQuote;
  isEdited?: boolean;
  editedAt?: number;
}

export interface JoinRoomResponse {
  ok: boolean;
  count?: number;
  partnerOnline?: boolean;
  partnerLastSeen?: number | null;
  myLastSeen?: number | null;
  history?: EncryptedPayload[];
  userSettings?: {
    soundEnabled: boolean;
    notificationsEnabled: boolean;
  };
  error?: string;
}

export type CallType = 'audio' | 'video';
export type CallStatus = 'idle' | 'calling' | 'incoming' | 'connected' | 'ended';

export interface ActiveCall {
  callId: string;
  partnerRole: Role;
  partnerName: string;
  isVideo: boolean;
  status: CallStatus;
  durationSeconds: number;
  isMuted: boolean;
  isVideoEnabled: boolean;
}

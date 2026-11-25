import { Injectable } from '@angular/core';
import { BehaviorSubject, Subscription } from 'rxjs';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActiveCall, Role } from '../models/chat.models';
import { SocketService } from './socket.service';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

@Injectable({
  providedIn: 'root'
})
export class WebRtcService {
  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;

  public activeCall$ = new BehaviorSubject<ActiveCall | null>(null);
  public localStream$ = new BehaviorSubject<MediaStream | null>(null);
  public remoteStream$ = new BehaviorSubject<MediaStream | null>(null);

  private callTimer: any = null;
  private subs = new Subscription();

  constructor(
    private socketService: SocketService,
    private snackBar: MatSnackBar
  ) {
    this.initSocketListeners();
  }

  showWarning(message: string): void {
    this.snackBar.open(message, 'Close', {
      duration: 3000,
      verticalPosition: 'top',
      horizontalPosition: 'center',
      panelClass: ['warning-snackbar']
    });
  }

  private initSocketListeners(): void {
    // 1. Incoming Call
    this.subs.add(
      this.socketService.incomingCall$.subscribe(async (incoming) => {
        const current = this.activeCall$.value;
        if (current && current.status !== 'idle' && current.status !== 'ended') {
          // Already on a call -> auto reject
          this.socketService.rejectCall({ toRole: incoming.fromRole });
          return;
        }

        this.activeCall$.next({
          callId: incoming.callId,
          partnerRole: incoming.fromRole,
          partnerName: incoming.fromName,
          isVideo: incoming.isVideo,
          status: 'incoming',
          durationSeconds: 0,
          isMuted: false,
          isVideoEnabled: incoming.isVideo
        });
      })
    );

    // 2. Call Answered (Sender side)
    this.subs.add(
      this.socketService.callAnswered$.subscribe(async ({ answer, fromRole }) => {
        if (!this.peerConnection) return;
        try {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
          this.setConnectedState();
        } catch (err) {
          console.error('Error setting remote description:', err);
        }
      })
    );

    // 3. ICE Candidate
    this.subs.add(
      this.socketService.iceCandidate$.subscribe(async ({ candidate }) => {
        if (!this.peerConnection || !candidate) return;
        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.warn('Error adding ICE candidate:', err);
        }
      })
    );

    // 4. Call Ended / Rejected / Failed
    this.subs.add(
      this.socketService.callEnded$.subscribe(() => {
        this.cleanupCall('ended');
      })
    );

    this.subs.add(
      this.socketService.callRejected$.subscribe(() => {
        this.showWarning('Call was declined.');
        this.cleanupCall('ended');
      })
    );

    this.subs.add(
      this.socketService.callFailed$.subscribe(({ reason }) => {
        this.showWarning(reason === 'partner_offline' ? 'Partner is currently offline.' : 'Call failed.');
        this.cleanupCall('ended');
      })
    );
  }

  async startCall(partnerRole: Role, isVideo: boolean): Promise<void> {
    const callId = crypto.randomUUID ? crypto.randomUUID() : `call-${Date.now()}`;
    const partnerName = partnerRole === 'he' ? 'Harry' : 'Elira';

    this.activeCall$.next({
      callId,
      partnerRole,
      partnerName,
      isVideo,
      status: 'calling',
      durationSeconds: 0,
      isMuted: false,
      isVideoEnabled: isVideo
    });

    try {
      await this.acquireUserMedia(isVideo);

      // Disable audio track during 'calling' state so voice does NOT leak before call is answered!
      if (this.localStream) {
        this.localStream.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
      }

      this.createPeerConnection(partnerRole);

      // Add local tracks to peer connection
      if (this.localStream) {
        this.localStream.getTracks().forEach((track) => {
          this.peerConnection?.addTrack(track, this.localStream!);
        });
      }

      const offer = await this.peerConnection!.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: isVideo
      });

      await this.peerConnection!.setLocalDescription(offer);

      this.socketService.callUser({
        toRole: partnerRole,
        offer,
        isVideo,
        callId
      });
    } catch (err: any) {
      console.error('Failed to start call:', err);
      this.showWarning('Could not access microphone/camera: ' + (err.message || err));
      this.cleanupCall('ended');
    }
  }

  async acceptCall(incomingOffer: any): Promise<void> {
    const call = this.activeCall$.value;
    if (!call) return;

    try {
      await this.acquireUserMedia(call.isVideo);
      this.createPeerConnection(call.partnerRole);

      if (this.localStream) {
        this.localStream.getTracks().forEach((track) => {
          this.peerConnection?.addTrack(track, this.localStream!);
        });
      }

      await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(incomingOffer));

      const answer = await this.peerConnection!.createAnswer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: call.isVideo
      });
      await this.peerConnection!.setLocalDescription(answer);

      this.socketService.answerCall({
        toRole: call.partnerRole,
        answer,
        callId: call.callId
      });

      this.setConnectedState();
    } catch (err: any) {
      console.error('Failed to accept call:', err);
      this.showWarning('Error accepting call: ' + (err.message || err));
      this.rejectCall();
    }
  }

  rejectCall(): void {
    const call = this.activeCall$.value;
    if (call) {
      this.socketService.rejectCall({ toRole: call.partnerRole });
    }
    this.cleanupCall('ended');
  }

  endCall(): void {
    const call = this.activeCall$.value;
    if (call) {
      this.socketService.endCall({ toRole: call.partnerRole, reason: 'hangup' });
    }
    this.cleanupCall('ended');
  }

  toggleAudio(): boolean {
    if (!this.localStream) return false;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      const call = this.activeCall$.value;
      if (call) {
        this.activeCall$.next({ ...call, isMuted: !audioTrack.enabled });
      }
      return audioTrack.enabled;
    }
    return false;
  }

  toggleVideo(): boolean {
    if (!this.localStream) return false;
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      const call = this.activeCall$.value;
      if (call) {
        this.activeCall$.next({ ...call, isVideoEnabled: videoTrack.enabled });
      }
      return videoTrack.enabled;
    }
    return false;
  }

  private async acquireUserMedia(video: boolean): Promise<void> {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false
    });
    this.localStream$.next(this.localStream);
  }

  private createPeerConnection(partnerRole: Role): void {
    this.peerConnection = new RTCPeerConnection(RTC_CONFIG);
    this.remoteStream = new MediaStream();
    this.remoteStream$.next(this.remoteStream);

    this.peerConnection.ontrack = (event) => {
      console.log('WebRTC ontrack received:', event.track.kind);
      if (event.streams && event.streams[0]) {
        this.remoteStream = event.streams[0];
      } else {
        if (!this.remoteStream) this.remoteStream = new MediaStream();
        if (!this.remoteStream.getTracks().some(t => t.id === event.track.id)) {
          this.remoteStream.addTrack(event.track);
        }
      }
      this.remoteStream$.next(new MediaStream(this.remoteStream.getTracks()));
    };

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.socketService.sendIceCandidate({
          toRole: partnerRole,
          candidate: event.candidate
        });
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      if (this.peerConnection?.connectionState === 'disconnected' || this.peerConnection?.connectionState === 'failed') {
        this.cleanupCall('ended');
      }
    };
  }

  private setConnectedState(): void {
    const call = this.activeCall$.value;
    if (call) {
      this.activeCall$.next({ ...call, status: 'connected' });
    }

    // Now that call is officially answered and connected, un-mute local microphone!
    if (this.localStream) {
      const isMuted = this.activeCall$.value?.isMuted || false;
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !isMuted;
      });
    }

    if (this.callTimer) clearInterval(this.callTimer);
    this.callTimer = setInterval(() => {
      const c = this.activeCall$.value;
      if (c && c.status === 'connected') {
        this.activeCall$.next({ ...c, durationSeconds: c.durationSeconds + 1 });
      }
    }, 1000);
  }

  private cleanupCall(status: 'idle' | 'ended' = 'idle'): void {
    if (this.callTimer) {
      clearInterval(this.callTimer);
      this.callTimer = null;
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        track.stop();
        track.enabled = false;
      });
      this.localStream = null;
      this.localStream$.next(null);
    }

    if (this.peerConnection) {
      this.peerConnection.ontrack = null;
      this.peerConnection.onicecandidate = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.remoteStream = null;
    this.remoteStream$.next(null);

    const call = this.activeCall$.value;
    if (call) {
      this.activeCall$.next({ ...call, status: 'ended' });
      setTimeout(() => {
        this.activeCall$.next(null);
      }, 1000);
    } else {
      this.activeCall$.next(null);
    }
  }

  formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
    const secs = (seconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
  }
}

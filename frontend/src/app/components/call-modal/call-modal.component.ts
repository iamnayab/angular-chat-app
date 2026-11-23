import {
  Component,
  OnInit,
  OnDestroy,
  AfterViewChecked,
  ViewChild,
  ElementRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { ActiveCall } from '../../models/chat.models';
import { WebRtcService } from '../../services/webrtc.service';
import { SocketService } from '../../services/socket.service';
import { AudioService } from '../../services/audio.service';

@Component({
  selector: 'app-call-modal',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './call-modal.component.html',
  styleUrls: ['./call-modal.component.css']
})
export class CallModalComponent implements OnInit, OnDestroy, AfterViewChecked {
  @ViewChild('localVideoRef') private localVideoRef?: ElementRef<HTMLVideoElement>;
  @ViewChild('remoteVideoRef') private remoteVideoRef?: ElementRef<HTMLVideoElement>;
  @ViewChild('remoteAudioRef') private remoteAudioRef?: ElementRef<HTMLAudioElement>;

  activeCall: ActiveCall | null = null;
  private incomingOffer: any = null;
  private attachedLocalStream: MediaStream | null = null;
  private attachedRemoteStream: MediaStream | null = null;
  private attachedRemoteAudioStream: MediaStream | null = null;
  private subs = new Subscription();

  constructor(
    public webrtcService: WebRtcService,
    private socketService: SocketService,
    private audioService: AudioService
  ) {}

  ngOnInit(): void {
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

  ngAfterViewChecked(): void {
    this.syncStreams();
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  private syncStreams(): void {
    const localStream = this.webrtcService.localStream$.value;
    const remoteStream = this.webrtcService.remoteStream$.value;

    // Reset streams when call has ended or no active call
    if (!this.activeCall || this.activeCall.status === 'ended') {
      if (this.remoteAudioRef?.nativeElement) {
        this.remoteAudioRef.nativeElement.srcObject = null;
        this.remoteAudioRef.nativeElement.muted = true;
      }
      if (this.remoteVideoRef?.nativeElement) {
        this.remoteVideoRef.nativeElement.srcObject = null;
      }
      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = null;
      }
      this.attachedLocalStream = null;
      this.attachedRemoteStream = null;
      this.attachedRemoteAudioStream = null;
      return;
    }

    // 1. Dedicated remote audio playback (ONLY when call is officially answered and connected!)
    if (this.remoteAudioRef?.nativeElement) {
      if (this.activeCall.status === 'connected' && remoteStream) {
        if (this.attachedRemoteAudioStream !== remoteStream) {
          this.remoteAudioRef.nativeElement.srcObject = remoteStream;
          this.attachedRemoteAudioStream = remoteStream;
        }
        this.remoteAudioRef.nativeElement.muted = false;
        this.remoteAudioRef.nativeElement.play().catch(e => console.warn('Remote audio autoplay error:', e));
      } else {
        this.remoteAudioRef.nativeElement.muted = true;
      }
    }

    // 2. Video streams
    if (this.localVideoRef?.nativeElement && localStream && this.attachedLocalStream !== localStream) {
      this.localVideoRef.nativeElement.srcObject = localStream;
      this.attachedLocalStream = localStream;
    }

    if (this.remoteVideoRef?.nativeElement) {
      if (this.activeCall.status === 'connected' && remoteStream) {
        if (this.attachedRemoteStream !== remoteStream) {
          this.remoteVideoRef.nativeElement.srcObject = remoteStream;
          this.attachedRemoteStream = remoteStream;
        }
      } else {
        this.remoteVideoRef.nativeElement.srcObject = null;
        this.attachedRemoteStream = null;
      }
    }
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
}

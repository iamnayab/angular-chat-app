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

  activeCall: ActiveCall | null = null;
  private incomingOffer: any = null;
  private attachedLocalStream: MediaStream | null = null;
  private attachedRemoteStream: MediaStream | null = null;
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
    this.syncVideoStreams();
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
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

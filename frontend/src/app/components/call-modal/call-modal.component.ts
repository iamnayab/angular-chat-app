import {
  Component,
  OnInit,
  OnDestroy,
  AfterViewChecked,
  ViewChild,
  ElementRef,
  HostListener,
  ChangeDetectorRef
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
  @ViewChild('floatingContainer') private floatingContainer?: ElementRef<HTMLDivElement>;

  activeCall: ActiveCall | null = null;
  isFloating: boolean = true; // Floating mode enabled by default so chat and call happen together!

  // Dragging support for floating call card
  isDragging = false;
  floatingLeft: number | null = null;
  floatingTop: number | null = null;
  private dragStartX = 0;
  private dragStartY = 0;
  private startElemX = 0;
  private startElemY = 0;

  private incomingOffer: any = null;
  private attachedLocalStream: MediaStream | null = null;
  private attachedRemoteStream: MediaStream | null = null;
  private attachedRemoteAudioStream: MediaStream | null = null;
  private subs = new Subscription();

  constructor(
    public webrtcService: WebRtcService,
    private socketService: SocketService,
    private audioService: AudioService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.subs.add(
      this.webrtcService.activeCall$.subscribe((call) => {
        this.activeCall = call;
        if (!call || call.status === 'ended') {
          this.isFloating = true;
          this.floatingLeft = null;
          this.floatingTop = null;
        }
        this.cdr.markForCheck();
        setTimeout(() => this.syncStreams(), 0);
      })
    );

    this.subs.add(
      this.webrtcService.localStream$.subscribe(() => {
        this.cdr.markForCheck();
        setTimeout(() => this.syncStreams(), 0);
      })
    );

    this.subs.add(
      this.webrtcService.remoteStream$.subscribe(() => {
        this.cdr.markForCheck();
        setTimeout(() => this.syncStreams(), 0);
      })
    );

    this.subs.add(
      this.socketService.incomingCall$.subscribe((incoming) => {
        this.incomingOffer = incoming.offer;
        this.audioService.playRingChime();
        this.cdr.markForCheck();
      })
    );
  }

  ngAfterViewChecked(): void {
    this.syncStreams();
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  toggleFloating(): void {
    this.isFloating = !this.isFloating;
    // When expanding to full screen, reset custom floating drag coordinates
    if (!this.isFloating) {
      this.floatingLeft = null;
      this.floatingTop = null;
    }
  }

  // -------------------------------------------------------------
  // Drag handling for Floating Call Box
  // -------------------------------------------------------------
  onDragStart(event: MouseEvent | TouchEvent): void {
    if (!this.isFloating || !this.floatingContainer?.nativeElement) return;

    // Don't drag if clicking buttons
    const target = event.target as HTMLElement;
    if (target.closest('button')) return;

    this.isDragging = true;
    const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX;
    const clientY = 'touches' in event ? event.touches[0].clientY : event.clientY;

    const rect = this.floatingContainer.nativeElement.getBoundingClientRect();
    this.startElemX = rect.left;
    this.startElemY = rect.top;
    this.dragStartX = clientX;
    this.dragStartY = clientY;
  }

  @HostListener('document:mousemove', ['$event'])
  @HostListener('document:touchmove', ['$event'])
  onDragMove(event: MouseEvent | TouchEvent): void {
    if (!this.isDragging || !this.floatingContainer?.nativeElement) return;

    const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX;
    const clientY = 'touches' in event ? event.touches[0].clientY : event.clientY;

    const deltaX = clientX - this.dragStartX;
    const deltaY = clientY - this.dragStartY;

    const rect = this.floatingContainer.nativeElement.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 10;
    const maxY = window.innerHeight - rect.height - 10;

    let newX = this.startElemX + deltaX;
    let newY = this.startElemY + deltaY;

    newX = Math.max(10, Math.min(maxX, newX));
    newY = Math.max(10, Math.min(maxY, newY));

    this.floatingLeft = newX;
    this.floatingTop = newY;
  }

  @HostListener('document:mouseup')
  @HostListener('document:touchend')
  onDragEnd(): void {
    this.isDragging = false;
  }

  // -------------------------------------------------------------
  // Stream Sync & Audio Echo Prevention
  // -------------------------------------------------------------
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
        this.remoteVideoRef.nativeElement.muted = true;
      }
      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = null;
        this.localVideoRef.nativeElement.muted = true;
      }
      this.attachedLocalStream = null;
      this.attachedRemoteStream = null;
      this.attachedRemoteAudioStream = null;
      return;
    }

    // 1. Dedicated remote audio playback:
    // ONLY played via <audio #remoteAudioRef> when call is connected
    if (this.remoteAudioRef?.nativeElement) {
      if (this.activeCall.status === 'connected' && remoteStream && remoteStream.getAudioTracks().length > 0) {
        if (this.remoteAudioRef.nativeElement.srcObject !== remoteStream) {
          this.remoteAudioRef.nativeElement.srcObject = remoteStream;
        }
        this.remoteAudioRef.nativeElement.muted = false;
        this.remoteAudioRef.nativeElement.play().catch(e => console.warn('Remote audio autoplay:', e));
      } else {
        this.remoteAudioRef.nativeElement.muted = true;
      }
    }

    // 2. Local Video Feed:
    // MUST BE PERMANENTLY MUTED with volume 0 to prevent hearing self voice return!
    if (this.localVideoRef?.nativeElement) {
      this.localVideoRef.nativeElement.muted = true;
      this.localVideoRef.nativeElement.volume = 0;
      if (localStream && localStream.getVideoTracks().length > 0) {
        if (this.localVideoRef.nativeElement.srcObject !== localStream) {
          this.localVideoRef.nativeElement.srcObject = localStream;
        }
        this.localVideoRef.nativeElement.play().catch(e => console.warn('Local video play:', e));
      } else if (!localStream) {
        this.localVideoRef.nativeElement.srcObject = null;
      }
    }

    // 3. Remote Video Feed:
    // MUTED to avoid dual-playback because <audio #remoteAudioRef> already plays remote sound!
    if (this.remoteVideoRef?.nativeElement) {
      this.remoteVideoRef.nativeElement.muted = true;
      this.remoteVideoRef.nativeElement.volume = 0;
      if (this.activeCall.status === 'connected' && remoteStream && remoteStream.getVideoTracks().length > 0) {
        if (this.remoteVideoRef.nativeElement.srcObject !== remoteStream) {
          this.remoteVideoRef.nativeElement.srcObject = remoteStream;
        }
        this.remoteVideoRef.nativeElement.play().catch(e => console.warn('Remote video play:', e));
      } else if (this.activeCall.status === 'calling') {
        this.remoteVideoRef.nativeElement.srcObject = null;
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

import {
  Component,
  EventEmitter,
  Output,
  ViewChild,
  ElementRef,
  AfterViewInit
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CryptoService } from '../../services/crypto.service';

@Component({
  selector: 'app-unlock',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './unlock.component.html',
  styleUrls: ['./unlock.component.css']
})
export class UnlockComponent implements AfterViewInit {
  @Output() unlocked = new EventEmitter<{ roomId: string; encryptionKey: CryptoKey }>();

  @ViewChild('roomIdInputRef') roomIdInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('passwordInputRef') passwordInputRef?: ElementRef<HTMLInputElement>;

  roomIdInput = '';
  passwordInput = '';
  joinError = '';
  isVerifying = false;

  constructor(private cryptoService: CryptoService) {}

  ngAfterViewInit(): void {
    setTimeout(() => {
      this.roomIdInputRef?.nativeElement?.focus();
    }, 100);
  }

  /**
   * Automatically shifts cursor to Password field when 4 digits are typed
   */
  onRoomIdInput(): void {
    if (this.roomIdInput && this.roomIdInput.trim().length === 4) {
      this.passwordInputRef?.nativeElement?.focus();
    }
  }

  /**
   * If Enter is pressed on PIN field, prevent submit and shift cursor to Password
   */
  onRoomIdKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.passwordInputRef?.nativeElement?.focus();
    }
  }

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

      const encryptionKey = await this.cryptoService.deriveKey(pass, room);

      // Clear input fields immediately for privacy
      this.roomIdInput = '';
      this.passwordInput = '';
      this.isVerifying = false;

      // Notify parent shell
      this.unlocked.emit({ roomId: room, encryptionKey });
    } catch (err: any) {
      this.isVerifying = false;
      this.joinError = 'Encryption error: ' + (err.message || err);
    }
  }
}

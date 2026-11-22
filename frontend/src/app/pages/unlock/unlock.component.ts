import { Component, EventEmitter, Output } from '@angular/core';
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
export class UnlockComponent {
  @Output() unlocked = new EventEmitter<{ roomId: string; encryptionKey: CryptoKey }>();

  roomIdInput = '';
  passwordInput = '';
  joinError = '';
  isVerifying = false;

  constructor(private cryptoService: CryptoService) {}

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

import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-attachment-modal',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './attachment-modal.component.html',
  styleUrls: ['./attachment-modal.component.css']
})
export class AttachmentModalComponent {
  @Input() show = false;
  @Input() stagedFile: File | null = null;
  @Input() stagedFilePreviewUrl: string | null = null;
  @Input() stagedFileIsImage = false;
  @Input() stagedFileName = '';
  @Input() stagedFileMetaText = '';
  @Input() stagedFileIcon = '📎';
  @Input() isSending = false;
  @Input() error = '';

  @Output() close = new EventEmitter<void>();
  @Output() send = new EventEmitter<void>();

  onClose(): void {
    if (!this.isSending) {
      this.close.emit();
    }
  }

  onSend(): void {
    if (!this.isSending) {
      this.send.emit();
    }
  }
}

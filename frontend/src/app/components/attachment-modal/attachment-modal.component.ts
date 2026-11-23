import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-attachment-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
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
  @Output() send = new EventEmitter<string>();

  caption = '';

  onClose(): void {
    if (!this.isSending) {
      this.caption = '';
      this.close.emit();
    }
  }

  onSend(): void {
    if (!this.isSending) {
      this.send.emit(this.caption.trim());
      this.caption = '';
    }
  }
}

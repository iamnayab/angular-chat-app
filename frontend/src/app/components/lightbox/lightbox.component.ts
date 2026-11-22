import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-lightbox',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './lightbox.component.html',
  styleUrls: ['./lightbox.component.css']
})
export class LightboxComponent {
  @Input() show = false;
  @Input() imageUrl = '';
  @Input() title = '';

  @Output() close = new EventEmitter<void>();
  @Output() download = new EventEmitter<{ url: string; title: string }>();

  onClose(): void {
    this.close.emit();
  }

  onDownload(): void {
    this.download.emit({ url: this.imageUrl, title: this.title });
  }
}

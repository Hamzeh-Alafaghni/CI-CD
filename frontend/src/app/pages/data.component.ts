import { Component, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ApiService, Item } from '../services/api.service';

@Component({
  selector: 'app-data',
  standalone: true,
  imports: [DatePipe],
  template: `
    <section class="panel">
      <h1>Data</h1>
      <p class="muted">Live from the .NET API at <code>/api/items</code>.</p>

      @if (loading()) {
        <p>Loading…</p>
      } @else if (error()) {
        <p class="error">Could not reach the API: {{ error() }}</p>
        <button class="btn" (click)="load()">Retry</button>
      } @else {
        <table class="grid">
          <thead>
            <tr><th>#</th><th>Name</th><th>Category</th><th>Created (UTC)</th></tr>
          </thead>
          <tbody>
            @for (item of items(); track item.id) {
              <tr>
                <td>{{ item.id }}</td>
                <td>{{ item.name }}</td>
                <td><span class="tag">{{ item.category }}</span></td>
                <td>{{ item.createdUtc | date: 'medium' }}</td>
              </tr>
            }
          </tbody>
        </table>
      }
    </section>
  `,
})
export class DataComponent implements OnInit {
  protected readonly items = signal<Item[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  constructor(private readonly api: ApiService) {}

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.getItems().subscribe({
      next: (data) => {
        this.items.set(data);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.message ?? 'unknown error');
        this.loading.set(false);
      },
    });
  }
}

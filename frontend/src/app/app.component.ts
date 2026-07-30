import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { environment } from '../environments/environment';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="topbar">
      <div class="brand">Simple Web App</div>
      <nav>
        <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Home</a>
        <a routerLink="/about" routerLinkActive="active">About</a>
        <a routerLink="/data" routerLinkActive="active">Data</a>
      </nav>
      <span class="env" [class.prod]="environment.production">{{ environment.name }}</span>
    </header>

    <main class="content">
      <router-outlet></router-outlet>
    </main>

    <footer class="footer">
      Deployed to IIS via GitHub Actions &bull; {{ environment.name }} build
    </footer>
  `,
})
export class AppComponent {
  protected readonly environment = environment;
}

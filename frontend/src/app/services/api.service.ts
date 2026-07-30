import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface Item {
  id: number;
  name: string;
  category: string;
  createdUtc: string;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  // environment.apiUrl is '' in production (same-origin) or a full URL in dev.
  private readonly baseUrl = environment.apiUrl;

  constructor(private readonly http: HttpClient) {}

  getItems(): Observable<Item[]> {
    return this.http.get<Item[]>(`${this.baseUrl}/api/items`);
  }
}

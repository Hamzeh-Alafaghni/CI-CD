// Staging environment — used by `ng build --configuration staging`.
// Point apiUrl at the staging API site on your IIS server.
export const environment = {
  production: false,
  name: 'staging',
  apiUrl: 'http://localhost:8081',
};

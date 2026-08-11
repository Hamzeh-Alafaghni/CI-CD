// Production environment — used by `ng build --configuration production`.
// Point apiUrl at the production API site on your IIS server.
// Using a relative "/api" works well if the API is hosted under the same host.
export const environment = {
  production: true,
  name: 'production',
  apiUrl: 'http://54.175.194.187:8080',
};

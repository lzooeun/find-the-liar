import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', // 외부 접속 허용
    port: 5173,
    strictPort: true, // 포트 고정
    
    // ⭐ 중요: 디스코드 보안 정책(CSP) 우회 설정
    hmr: {
      clientPort: 443, // 터널은 HTTPS(443)를 사용하므로 포트를 맞춰줍니다.
    },
    
    // ⭐ 중요: 접속 허용 도메인 설정 (와일드카드 사용)
    allowedHosts: [
      '.trycloudflare.com',
      '.discordsays.com'
    ],

    proxy: {
      '/socket.io': {
        target: 'http://127.0.0.1:3001',
        ws: true, // 웹소켓 허용 필수!
        changeOrigin: true
      },
      '/api': { // 토큰 인증 API도 백엔드로 전달
        target: 'http://127.0.0.1:3001',
        changeOrigin: true
      }
    }
  }
})

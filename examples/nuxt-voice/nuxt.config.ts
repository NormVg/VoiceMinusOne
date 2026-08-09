// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  // Transpile workspace packages so Nuxt can resolve them
  build: {
    transpile: [
      '@voiceminusone/core',
      '@voiceminusone/client',
      '@voiceminusone/server',
    ],
  },
  // Allow the server plugin to use ws
  nitro: {
    externals: {
      inline: ['@voiceminusone/core', '@voiceminusone/client', '@voiceminusone/server'],
    },
  },
})

// Temporary augmentation so TypeScript recognizes new User fields until editor reloads Prisma types.
import '@prisma/client'

declare module '@prisma/client' {
  interface User {
    mustChangePassword: boolean
    passwordChangedAt: Date | null
  }
}

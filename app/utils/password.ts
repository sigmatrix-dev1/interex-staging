import bcrypt from 'bcryptjs'

export function createPassword(password: string) {
  return {
    hash: bcrypt.hashSync(password, 10),
  }
}

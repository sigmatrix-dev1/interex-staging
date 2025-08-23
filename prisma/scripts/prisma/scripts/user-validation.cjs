// Shared user validation for scripts (CommonJS compatible)
const { z } = require('zod')

const USERNAME_MIN_LENGTH = 3
const USERNAME_MAX_LENGTH = 20

const UsernameSchema = z
  .string({ required_error: 'Username is required' })
  .min(USERNAME_MIN_LENGTH, { message: 'Username is too short' })
  .max(USERNAME_MAX_LENGTH, { message: 'Username is too long' })
  .regex(/^[a-zA-Z0-9_]+$/, {
    message: 'Username can only include letters, numbers, and underscores',
  })
  .transform((value) => value.toLowerCase())

const EmailSchema = z
  .string({ required_error: 'Email is required' })
  .email({ message: 'Email is invalid' })
  .min(3, { message: 'Email is too short' })
  .max(100, { message: 'Email is too long' })
  .transform((value) => value.toLowerCase())

module.exports = { UsernameSchema, EmailSchema };

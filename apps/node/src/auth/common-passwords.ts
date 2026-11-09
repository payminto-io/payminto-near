/**
 * Common passwords of 12 or more characters, lowercased (shorter ones are refused by the length rule anyway).
 * Taken from the long entries of public breach frequency lists; pattern checks in passwords.ts catch the variants
 * (repeats, keyboard and number runs, a common word followed by digits).
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "123456789012", "1234567890123", "12345678901234", "123456789123", "1234567891011", "123123123123", "111111111111",
  "000000000000", "123456123456", "987654321987", "147258369147", "123321123321", "121212121212", "112233445566",
  "password1234", "password12345", "password123456", "password1234!", "password@123", "password!123", "passwordpassword",
  "qwertyuiop12", "qwertyuiop123", "qwertyuiopasdf", "qwertyuiopasdfghjkl", "qwerty123456", "qwerty1234567", "1qaz2wsx3edc",
  "1qaz2wsx3edc4rfv", "zaq12wsxcde3", "1q2w3e4r5t6y", "1q2w3e4r5t6y7u", "q1w2e3r4t5y6", "asdfghjkl123", "zxcvbnm12345",
  "iloveyou1234", "iloveyouiloveyou", "iloveyou123456", "letmein12345", "letmeinletmein", "welcome12345", "welcome123456",
  "welcometothejungle", "administrator", "administrator1", "administrator123", "adminadminadmin", "admin1234567",
  "changeme1234", "changemenow!", "trustno1trustno1", "football1234", "baseball1234", "basketball12", "basketball123",
  "sunshine1234", "princess1234", "superman1234", "batman123456", "starwars1234", "monkey123456", "dragon123456",
  "shadow123456", "master123456", "michael12345", "jennifer1234", "whatever1234", "freedom12345", "thequickbrownfox",
  "thequickbrownfoxjumpsoverthelazydog", "correcthorsebatterystaple", "correct horse battery staple", "mypassword123",
  "mypassword1234", "yourpassword", "secretpassword", "supersecret123", "supersecretpassword", "nopassword123",
  "temppassword", "temporary123", "default12345", "defaultpassword", "abcdefghijkl", "abcdefghijklm", "abcd12345678",
  "abc123456789", "a1b2c3d4e5f6", "aaaaaaaaaaaa", "1234qwerasdf", "1234qwerasdfzxcv", "qazwsxedcrfv", "qazwsxedcrfvtgb",
  "poiuytrewq12", "mnbvcxzlkjhg", "computer1234", "internet1234", "samsung12345", "liverpool123", "chelsea12345",
  "arsenal12345", "manchester12", "manchesterunited", "pokemon12345", "minecraft123", "minecraft1234", "fortnite1234",
  "blink182blink182", "princess12345", "lovelovelove", "babygirl1234", "iloveyoubaby", "loveyouforever", "jesus1234567",
  "jesuschrist1", "godisgood123", "blessed12345", "hellohello12", "helloworld12", "helloworld123", "hello1234567",
  "goodmorning1", "happybirthday", "happy1234567", "summer123456", "winter123456", "spring123456", "autumn123456",
  "january12345", "december1234", "september123", "november1234", "bitcoin12345", "bitcoin123456", "ethereum1234",
  "cryptocurrency", "satoshinakamoto", "tothemoon123", "hodlhodlhodl", "metamask1234", "wallet123456", "payminto1234",
  "payminto12345", "hashkey12345", "hashkeychain", "hashkeychain1", "stablecoin12", "usdc12345678",
]);

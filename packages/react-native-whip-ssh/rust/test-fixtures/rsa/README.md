Throwaway 2048-bit RSA key used only by `src/ssh/tests.rs`. It is not
authorized anywhere. The same key is stored in every encoding Whip accepts or
explicitly rejects; the encrypted variants use the passphrase `test-passphrase`.

Regenerate with:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out pkcs8.pem
openssl pkey -in pkcs8.pem -traditional -out pkcs1.pem
cp pkcs8.pem openssh && ssh-keygen -p -N '' -f openssh
cp openssh openssh-encrypted && ssh-keygen -p -P '' -N test-passphrase -f openssh-encrypted
openssl pkcs8 -topk8 -v2 aes-256-cbc -in pkcs8.pem -passout pass:test-passphrase -out pkcs8-encrypted.pem
openssl rsa -in pkcs8.pem -traditional -aes256 -passout pass:test-passphrase -out pkcs1-encrypted.pem
ssh-keygen -y -f openssh | awk '{print $1, $2}' > id_rsa.pub
```

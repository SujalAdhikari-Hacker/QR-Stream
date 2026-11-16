"""Generate a self-signed cert/key pair for the QR transfer server."""
import ipaddress, socket, datetime
from pathlib import Path

from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa

ROOT = Path(__file__).resolve().parent

def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()

ip = lan_ip()
print(f"Detected LAN IP: {ip}")

# --- key ---
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

# --- subject / issuer ---
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "qr-transfer")])

# --- SANs so browsers don't reject it outright ---
sans = [
    x509.DNSName("localhost"),
    x509.DNSName("qr-transfer"),
    x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
    x509.IPAddress(ipaddress.ip_address("::1")),
    x509.IPAddress(ipaddress.ip_address(ip)),
]

now = datetime.datetime.now(datetime.timezone.utc)
cert = (
    x509.CertificateBuilder()
    .subject_name(name)
    .issuer_name(name)
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(now - datetime.timedelta(days=1))
    .not_valid_after(now + datetime.timedelta(days=3650))
    .add_extension(x509.SubjectAlternativeName(sans), critical=False)
    .sign(key, hashes.SHA256())
)

(ROOT / "key.pem").write_bytes(
    key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    )
)
(ROOT / "cert.pem").write_bytes(
    cert.public_bytes(serialization.Encoding.PEM)
)

print("Wrote cert.pem and key.pem")
print(f"  cert covers: localhost, 127.0.0.1, ::1, {ip}")
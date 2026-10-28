package chat.amore.app;

import android.content.Context;
import android.net.http.SslCertificate;
import android.os.Bundle;
import android.util.Base64;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.CertPath;
import java.security.cert.CertPathValidator;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.PKIXParameters;
import java.security.cert.TrustAnchor;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * Servers installed offline (TLS_MODE=internal) use their own certificate authority. Instead of
 * asking users to install it into Android, the app stores that one CA (after the user compared its
 * fingerprint) and trusts it for that server only, on top of the normal system trust.
 */
final class Trust {
    private Trust() {}

    /** Leaf certificates already checked against the stored CA (WebView only gives us the leaf). */
    static final Set<String> verifiedLeaves = ConcurrentHashMap.newKeySet();

    static X509Certificate parse(byte[] der) throws CertificateException {
        return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));
    }

    static X509Certificate parsePem(String pem) throws CertificateException {
        return parse(pem.getBytes(StandardCharsets.US_ASCII));
    }

    static String toPem(X509Certificate c) throws CertificateException {
        return "-----BEGIN CERTIFICATE-----\n" + Base64.encodeToString(c.getEncoded(), Base64.DEFAULT) + "-----END CERTIFICATE-----\n";
    }

    static String sha256(X509Certificate c) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(c.getEncoded());
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < d.length; i++) {
                if (i > 0) sb.append(':');
                sb.append(String.format("%02X", d[i]));
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** CA stored for a given server (by URL or host). */
    static X509Certificate caFor(Context c, String urlOrHost) {
        String pem = Prefs.caFor(c, urlOrHost);
        if (pem == null) return null;
        try {
            return parsePem(pem);
        } catch (Exception e) {
            return null;
        }
    }

    static X509Certificate storedCa(Context c) {
        String pem = Prefs.ca(c);
        if (pem == null) return null;
        try {
            return parsePem(pem);
        } catch (Exception e) {
            return null;
        }
    }

    /** Does this chain (leaf first, as sent by the server) lead to the given CA? */
    static boolean chainTrusted(X509Certificate[] chain, X509Certificate ca) {
        if (chain == null || chain.length == 0 || ca == null) return false;
        try {
            List<X509Certificate> path = new ArrayList<>();
            for (X509Certificate c : chain) if (!Arrays.equals(c.getEncoded(), ca.getEncoded())) path.add(c);
            if (path.isEmpty()) return false;
            CertPath cp = CertificateFactory.getInstance("X.509").generateCertPath(path);
            PKIXParameters params = new PKIXParameters(Collections.singleton(new TrustAnchor(ca, null)));
            params.setRevocationEnabled(false);
            CertPathValidator.getInstance("PKIX").validate(cp, params);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static X509TrustManager systemTrust() throws Exception {
        TrustManagerFactory f = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        f.init((KeyStore) null);
        for (TrustManager t : f.getTrustManagers()) if (t instanceof X509TrustManager) return (X509TrustManager) t;
        throw new IllegalStateException("no system trust manager");
    }

    /** System trust first; then the stored CA of the configured server (if any). */
    static X509TrustManager trustManager(Context ctx, X509Certificate extraCa) {
        try {
            final X509TrustManager sys = systemTrust();
            final X509Certificate ca = extraCa != null ? extraCa : storedCa(ctx);
            return new X509TrustManager() {
                @Override
                public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                    sys.checkClientTrusted(chain, authType);
                }

                @Override
                public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                    try {
                        sys.checkServerTrusted(chain, authType);
                    } catch (CertificateException e) {
                        if (!chainTrusted(chain, ca)) throw e;
                    }
                }

                @Override
                public X509Certificate[] getAcceptedIssuers() {
                    return sys.getAcceptedIssuers();
                }
            };
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    static SSLSocketFactory socketFactory(Context ctx, X509Certificate extraCa) {
        try {
            SSLContext sc = SSLContext.getInstance("TLS");
            sc.init(null, new TrustManager[] {trustManager(ctx, extraCa)}, null);
            return sc.getSocketFactory();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /** The certificate chain a server presents, without judging it (used to check it ourselves). */
    static X509Certificate[] fetchChain(String host, int port) throws Exception {
        final X509Certificate[][] seen = new X509Certificate[1][];
        TrustManager capture = new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) {}

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) {
                seen[0] = chain;
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        };
        SSLContext sc = SSLContext.getInstance("TLS");
        sc.init(null, new TrustManager[] {capture}, null);
        try (SSLSocket s = (SSLSocket) sc.getSocketFactory().createSocket(host, port)) {
            s.setSoTimeout(10000);
            s.startHandshake();
        }
        return seen[0];
    }

    /** The leaf certificate inside a WebView SslError (works on all API levels). */
    static X509Certificate leafOf(SslCertificate cert) {
        try {
            Bundle b = SslCertificate.saveState(cert);
            byte[] der = b == null ? null : b.getByteArray("x509-certificate");
            return der == null ? null : parse(der);
        } catch (Exception e) {
            return null;
        }
    }
}

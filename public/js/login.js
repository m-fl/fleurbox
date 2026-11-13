// Login / first-run setup page (login.html)
// Start SSO Login
document.getElementById('btn-sso-login').addEventListener('click', () => {
    window.location.href = '/api/auth/oidc/login';
});

// Check for URL Error params
const urlParams = new URLSearchParams(window.location.search);
const error = urlParams.get('error');
if (error) {
    const errorMessage = document.getElementById('error-message');
    errorMessage.textContent = error;
    errorMessage.classList.add('show');
    // Clean URL
    window.history.replaceState({}, document.title, window.location.pathname);
}

// Check if setup is required
let isSetupMode = false;

async function checkSetupRequired() {
    try {
        const response = await fetch('/api/auth/setup-required');
        const data = await response.json();

        if (data.setupRequired) {
            isSetupMode = true;
            document.getElementById('login-subtitle').textContent = 'Create Admin Account';
            document.getElementById('submit-btn').textContent = 'Create Account';
            document.getElementById('setup-message').classList.add('show');
            document.getElementById('password').placeholder = 'Minimum 10 characters';
            document.getElementById('password').minLength = 10;
            // Hide SSO in setup mode
            document.querySelector('.sso-divider').style.display = 'none';
            document.getElementById('btn-sso-login').style.display = 'none';
        }
    } catch (err) {
        console.error('Error checking setup status:', err);
    }
}

// Handle form submission
document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const submitBtn = document.getElementById('submit-btn');
    const errorMessage = document.getElementById('error-message');

    // Clear previous errors
    errorMessage.classList.remove('show');
    errorMessage.textContent = '';

    // Disable button
    submitBtn.disabled = true;
    submitBtn.textContent = 'Please wait...';

    try {
        const endpoint = isSetupMode ? '/api/auth/setup' : '/api/auth/login';
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Authentication failed');
        }

        // The server set the login cookie; nothing to store here
        // Redirect to main app (replace history to prevent back button issues)
        // Back to what was open when the session expired (js/api.js Session)
        let back = '';
        try {
            back = sessionStorage.getItem('fleurbox_after_login') || '';
            sessionStorage.removeItem('fleurbox_after_login');
        } catch { /* storage blocked */ }
        window.location.replace('/' + (/^#[\w\-/%.:=&?]*$/.test(back) ? back : ''));

    } catch (err) {
        errorMessage.textContent = err.message;
        errorMessage.classList.add('show');
        submitBtn.disabled = false;
        submitBtn.textContent = isSetupMode ? 'Create Account' : 'Sign In';
    }
});

// Check setup status on load
checkSetupRequired();

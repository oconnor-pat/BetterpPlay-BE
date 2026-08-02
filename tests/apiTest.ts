const registrationData = {
  name: 'Test User',
  email: 'testuser@example.com',
  password: 'testpassword',
};

const apiUrl = 'http://localhost:8000'; // Update the URL to match your API endpoint

async function registerUser() {
  try {
    const { default: fetch } = await import('node-fetch');
    const response = await fetch(`${apiUrl}/auth/register`, {
      method: 'POST',
      body: JSON.stringify(registrationData),
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const responseData = await response.json();

    if (response.ok) {
      console.log('User registration successful:', responseData);
    } else {
      console.error('User registration failed:', responseData);
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

registerUser();

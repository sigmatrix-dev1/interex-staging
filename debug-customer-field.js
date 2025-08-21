#!/usr/bin/env node

/**
 * Debug script to test customer field dropdown behavior
 */

const puppeteer = require('puppeteer');

async function testCustomerFieldDropdown() {
  console.log('🔍 Testing customer field dropdown behavior...\n');

  const browser = await puppeteer.launch({ 
    headless: false, 
    slowMo: 100,
    defaultViewport: { width: 1200, height: 800 }
  });
  
  try {
    const page = await browser.newPage();
    
    // Enable console logging
    page.on('console', msg => console.log('🌐 PAGE LOG:', msg.text()));
    
    console.log('📋 Testing URL: http://localhost:3000/admin/users?action=add');
    await page.goto('http://localhost:3000/admin/users?action=add', { 
      waitUntil: 'networkidle0',
      timeout: 10000 
    });

    // Wait for drawer to appear
    console.log('⏳ Waiting for drawer to appear...');
    await page.waitForSelector('[data-drawer="true"]', { visible: true, timeout: 5000 });
    
    // Look for customer field
    console.log('🔍 Looking for customer field...');
    
    // Check if there's a read-only customer field
    const readOnlyField = await page.$('input[name="customerId"][type="hidden"]');
    const readOnlyDisplay = await page.$('div.bg-gray-50');
    
    // Check if there's a dropdown customer field
    const dropdownField = await page.$('select[name="customerId"]');
    
    console.log('\n📊 Customer Field Analysis:');
    console.log(`  Read-only field (hidden input): ${readOnlyField ? '✅ Found' : '❌ Not found'}`);
    console.log(`  Read-only display (gray div): ${readOnlyDisplay ? '✅ Found' : '❌ Not found'}`);
    console.log(`  Dropdown field (select): ${dropdownField ? '✅ Found' : '❌ Not found'}`);
    
    if (dropdownField) {
      console.log('\n🔍 Analyzing dropdown options...');
      const options = await page.$$eval('select[name="customerId"] option', options => 
        options.map(opt => ({ value: opt.value, text: opt.textContent }))
      );
      console.log('  Options found:', options.length);
      options.forEach((opt, i) => {
        console.log(`    ${i + 1}. "${opt.text}" (value: "${opt.value}")`);
      });
    }
    
    // Check URL parameters
    const url = page.url();
    const urlParams = new URL(url).searchParams;
    console.log('\n🔗 URL Parameters:');
    console.log(`  action: ${urlParams.get('action')}`);
    console.log(`  customerId: ${urlParams.get('customerId') || 'not set'}`);
    
    // Check drawer state in React
    console.log('\n🎭 Checking React component state...');
    const drawerState = await page.evaluate(() => {
      // Try to access React component state through DOM inspection
      const searchParams = new URLSearchParams(window.location.search);
      return {
        actionParam: searchParams.get('action'),
        customerIdParam: searchParams.get('customerId'),
        hasHiddenCustomerId: !!document.querySelector('input[name="customerId"][type="hidden"]'),
        hasSelectCustomerId: !!document.querySelector('select[name="customerId"]'),
        drawerVisible: !!document.querySelector('[data-drawer="true"]')
      };
    });
    
    console.log('  Drawer state:', drawerState);
    
    await page.waitForTimeout(3000);
    
  } catch (error) {
    console.error('❌ Error during test:', error.message);
  } finally {
    await browser.close();
  }
}

// Run the test
testCustomerFieldDropdown().catch(console.error);

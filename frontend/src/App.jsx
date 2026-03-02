import React from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import SearchPage from './pages/SearchPage.jsx'
import StreamPage from './pages/StreamPage.jsx'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<SearchPage />} />
        </Route>
        <Route path="/stream/:id" element={<StreamPage />} />
      </Routes>
    </BrowserRouter>
  )
}
